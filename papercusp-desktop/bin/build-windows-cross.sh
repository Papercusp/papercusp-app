#!/usr/bin/env bash
# Build the Windows x86_64 Inno Setup installer(s) by CROSS-COMPILING on THIS
# Linux box — no QEMU Windows VM, no SSH. Retires bin/build-windows-on-vm.sh's
# fragile, slow, lease-contended VM leg (WI-5651; the VM's heartbeat deaths
# caused 3 of WI-5600's failed builds, EI-18152964860625919).
#
# WHY THIS WORKS (all four gates proven end-to-end on Linux, 2026-07-20):
#   Gate 1  cargo-xwin cross-compiles a real release papercusp-desktop.exe
#           (PE32+ GUI x86-64, ~22MB, ~2m15s cold) — Tauri's supported Windows
#           target is MSVC and cargo-xwin manages the CRT + Windows SDK import
#           libs, so this is the SAME toolchain the VM used, minus the VM.
#   Gate 2  Inno Setup 6.7.3 under wine 9.0 packs a valid GUI setup.exe in ~64s
#           (vs the VM's ~40min) — same papercusp.iss, headless via xvfb.
#   Gate 2b The Server role DiskSpans identically (setup.exe stub + *-setup-N.bin
#           slices) — byte-shape-identical to the VM, so release-local.sh's
#           WI-5600 span->zip + record path consumes it unchanged.
#   Gate 3  Signing reproduces on Linux: the updater .sig (ed25519/minisign via
#           `tauri signer sign`) was ALWAYS a host-side step here; Authenticode
#           (osslsigncode) signs a cross-built PE and verifies "ok" WHEN the
#           owner supplies a cert (cert-conditional, currently a no-op in prod).
#
# ROLE CORRECTNESS (the subtlety a naive wiring gets wrong): the app resolves
# its role at runtime from the BAKED bundle identifier — app_role::detect(
# &app.config().identifier), main.rs:3594 — and generate_context!() bakes that
# identifier at COMPILE time from tauri.conf.json. So the Server binary MUST be
# compiled with com.papercusp.server baked in, exactly as the VM does two
# separate `tauri build --config tauri.server.conf.json` compiles. We replicate
# that by setting TAURI_CONFIG (the merge mechanism `tauri build --config` uses
# under the hood — @tauri-apps/cli CHANGELOG: "TAURI_CONFIG now represents the
# configuration to be merged") for the Server compile. One binary does NOT serve
# both roles — packing a Server installer around the GUI binary would ship a
# Server bundle that detects as GUI and never spawns the sidecar.
#
# ENV CONTRACT (mirrors bin/build-windows-on-vm.sh so release-local.sh can call
# either with the same env):
#   PAPERCUSP_BUILD_ROLES     roles to build (default "gui server")
#   PAPERCUSP_BUILD_SHA       baked into the exe (option_env!, /api/health)
#   PAPERCUSP_WINDOWS_SOURCE_REPAIR   exact committed-path native repair manifest;
#                                    legacy GUI-only, or explicit matching roles
#   PAPERCUSP_WINDOWS_SOURCE_REPAIR_REPO  repo containing its repair commits
#   PAPERCUSP_WINDOWS_OUTPUT_DIR      separate, empty output directory (required
#                                    for a repair; original cut stays immutable)
#   PAPERCUSP_BUILD_VERSION   shipped version (option_env!); also the installer
#                             filename version (falls back to tauri.conf.json)
#   PAPERCUSP_RELEASE_HOST    the updater's poll host, baked at compile (load via
#                             lib/release-host.sh); asserted present in the exe
#   PAPERCUSP_STAGE_SOURCE    1 (default) stages the dev/local runnable source
#                             tree -> sidecar/source.tar.zst so the Server role
#                             DiskSpans the "5-button" bundle (WI-3308)
#   PAPERCUSP_SINGLE_FILE     1 forces /DSingleFile (one setup.exe even for the
#                             Server tree; for hosting off a 2GiB-capped store)
#   TAURI_SIGNING_PRIVATE_KEY_PATH / _PASSWORD   updater .sig key (default
#                             ~/.papercusp/signing/papercusp.key, empty password)
#   WINDOWS_CERT_BASE64 + WINDOWS_CERT_PASSWORD  optional Authenticode: a
#                             base64 PKCS#12 code-signing cert. Unset => UNSIGNED
#                             (byte-identical to the current prod builds).
#   WINDOWS_SIGN_DIGEST       Authenticode digest (default sha256)
#   WINDOWS_SIGN_TIMESTAMP_URL RFC3161 TS server (default digicert); empty => no TS
#   PAPERCUSP_INNOEXTRACT     optional authoritative innoextract path/command
#                             override. Otherwise a compatible pinned
#                             ~/.papercusp/toolchains build is selected before
#                             PATH. The selected absolute consumer is
#                             fixture-tested before cargo xwin and inherited by
#                             the finished-artifact audit.
#
# PREREQS (release-local.sh does these before calling any Windows leg; this
# script SHIPS the tree as-is and never rebuilds them — same fail-closed
# contract as the VM script):
#   - bin/build-desktop-sidecar.sh has populated src-tauri/sidecar/
#   - scripts/build-rootfs.sh produced src-tauri/resources/papercup-runtime.tar.gz
#   - src-tauri/seed/ is cut (bin/ensure-release-seed.sh / cut-seed-cli)
#
# TOOLCHAIN (one-time, already provisioned on this box — WI-5651):
#   - cargo-xwin + `rustup target add x86_64-pc-windows-msvc` + clang/lld/llvm-rc
#   - wine 9.0 (+ wine32:i386) + Inno Setup 6.7.3 under WINEPREFIX
#     ~/.papercusp/wine-inno (ISCC at drive_c/InnoSetup6/ISCC.exe) + xvfb
#   - osslsigncode 2.8 (only used when a WINDOWS_CERT_* cert is supplied)

set -euo pipefail

# ── Self-read guard (WI-3306): parse the whole script before executing, so a
# peer's mid-run edit to this shared-tree file can't shift the running shell's
# read offset into changed bytes. Matching } + exit 0 at EOF.
{

# release-local can source this current producer with $0 naming a frozen
# release entrypoint. Helpers/audits belong to the producer we are executing;
# source and artifact paths must still belong to that frozen target.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_TAURI="$ROOT/src-tauri"
SOURCE_ROOT="$ROOT"
SUPERPROJECT_ROOT="$(cd "$SOURCE_ROOT/.." && pwd)"
OUTPUT_SRC_TAURI="$SRC_TAURI"
BUILD_CONTAINER=""
BUILD_ROOT=""
BUILD_WORKTREE=0

fail() { echo "ERROR: $*" >&2; exit 1; }

# The outer script is self-read, but a late child script is not. Capture the
# exact provenance emitter and its only local dependency before cargo/Inno can
# yield to a peer edit. Copy (never hardlink), validate, and attest those bytes.
snapshot_provenance_tools() {
  local dest="$1" source="$2" rel supplied="${PROVENANCE_TOOLCHAIN:-}"
  [[ -n "$supplied" ]] || supplied='{}'
  [[ ! -e "$dest" ]] || fail "provenance producer snapshot already exists"
  mkdir -p "$dest/lib"
  for rel in emit-build-provenance.sh lib/windows-source-repair.js; do
    cp -- "$source/$rel" "$dest/$rel"
  done
  bash -n "$dest/emit-build-provenance.sh" || fail "invalid snapshotted provenance emitter"
  node --check "$dest/lib/windows-source-repair.js" || fail "invalid snapshotted repair helper"
  node - "$dest" "$supplied" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [root, supplied] = process.argv.slice(2);
const toolchain = JSON.parse(supplied);
if (!toolchain || Array.isArray(toolchain) || typeof toolchain !== 'object') {
  throw new Error('provenance toolchain must be a JSON object');
}
const files = ['emit-build-provenance.sh', 'lib/windows-source-repair.js'].map(relative => ({
  path: relative,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex'),
}));
const producer = { schemaVersion: 1, files };
fs.writeFileSync(path.join(root, 'producer-inputs.json'), `${JSON.stringify(producer)}\n`);
process.stdout.write(JSON.stringify({ ...toolchain, windowsProvenanceProducer: producer }));
NODE
}

# Update source baked at compile (WI-4389/WI-3875): main.rs resolves it with
# option_env!("PAPERCUSP_RELEASE_HOST"). Load it here so a direct run of this
# script (not just via release-local.sh) still bakes a real host — omit it and
# the shipped app polls nothing and the Tauri updater reads that as "up to date"
# forever (the 0.0.8 defect). load_release_host is idempotent + override-safe.
# shellcheck source=lib/release-host.sh
source "$HERE/lib/release-host.sh"
load_release_host
# WI-20118266632432430: keep direct Windows builds aligned with release-local's
# span normalization and with the incremental publisher.
# shellcheck source=lib/inno-spanned-server.sh
source "$HERE/lib/inno-spanned-server.sh"
# EI-20551860898590077: inherit/verify the tag-scoped cut-start stamp when this
# producer is run directly or as a release-local child.
# shellcheck source=lib/release-artifacts.sh
source "$HERE/lib/release-artifacts.sh"
# EI-20962889392870069: use the same bounded cooperative writer acquisition as
# build-desktop-sidecar.sh. A long-lived tauri-guarded dev reader otherwise
# pins this release staging block forever at a bare `flock 9`.
# shellcheck source=lib/sidecar-lock-yield.sh
source "$HERE/lib/sidecar-lock-yield.sh"
# shellcheck source=lib/innoextract-compat-preflight.sh
source "$HERE/lib/innoextract-compat-preflight.sh"

TARGET="x86_64-pc-windows-msvc"
# Identity: keep build-box paths OUT of the shipped .exe. rustc embeds source paths
# (~/.cargo registry deps, ~/.rustup std) as rodata panic locations; the ELF link
# dead-strips the unreferenced ones but PE/COFF RETAINS them, exactly as Mach-O does
# (EI-20044309663936316). Measured on the 0014e cut: papercusp-desktop.exe carried 359
# occurrences of $HOME while the linux binary carried zero, and Windows runs no identity
# scan to say so (EI-20094260886633250 / EI-12889). Same flag that took pui 544 -> 0 in
# build-desktop-sidecar.sh (_PUI_REMAP). $HOME alone covers .cargo, .rustup and the repo.
_WIN_REMAP="--remap-path-prefix=$HOME=/build"
# ── crt-static (WI-39375, fixes WI-39372) ────────────────────────────────────
# STATICALLY LINK THE MSVC CRT. Without it the msvc target links the DYNAMIC CRT
# (toolchain default), so the shipped .exe hard-depends on VCRUNTIME140.dll /
# VCRUNTIME140_1.dll / MSVCP140.dll — and nothing in this repo ships or installs
# the VC++ redistributable. 0.0.17 reached users this way: it installs fine on a
# clean Windows, then dies at first launch with "The code execution cannot
# proceed because VCRUNTIME140.dll was not found" (reproduced on a clean Win11
# Ent LTSC 26100 guest). Invisible from the build side BY CONSTRUCTION — every
# build machine has Visual Studio, so the DLL is present exactly where the
# artifact is produced and missing only where it is consumed.
#
# WHY IT LIVES HERE AND NOT ONLY IN .cargo/config.toml — THIS IS THE TRAP:
# cargo's rustflag sources are MUTUALLY EXCLUSIVE, not additive. If the RUSTFLAGS
# ENV VAR is set, `target.*.rustflags` from .cargo/config.toml is IGNORED
# ENTIRELY. Line ~297 below sets RUSTFLAGS (for _WIN_REMAP), so a crt-static that
# lived only in config.toml would be SILENTLY DROPPED on this — the real release
# — path, producing a build that looks fixed and ships broken. Verified
# empirically, not assumed: a probe crate with `target.<host>.rustflags =
# ["--cfg","from_config_toml"]` emits `--cfg from_config_toml` with no env
# RUSTFLAGS, and emits ONLY `--cfg from_env` when RUSTFLAGS is set.
# config.toml keeps a copy for plain `cargo xwin build` invocations that set no
# env RUSTFLAGS; THIS is the copy that governs the shipped artifact.
#
# Same class the sibling rust-path-remap.sh header names: "release-critical build
# hygiene lives in the CALLER, so whether an artifact is shippable depends on
# which entry point produced it." Accordingly the guard below does not trust
# either copy — it asserts the property on the produced binary.
_WIN_CRT_STATIC="-C target-feature=+crt-static"
ROLES="${PAPERCUSP_BUILD_ROLES:-gui server}"
SOURCE_REPAIR="${PAPERCUSP_WINDOWS_SOURCE_REPAIR:-}"
if [[ -n "$SOURCE_REPAIR" ]]; then
  [[ -f "$SOURCE_REPAIR" ]] || fail "source repair manifest missing"
  node "$HERE/lib/windows-source-repair.js" roles "$SOURCE_REPAIR" "$ROLES" >/dev/null \
    || fail "source repair roles must exactly match requested build roles"
  [[ -n "${PAPERCUSP_WINDOWS_OUTPUT_DIR:-}" ]] \
    || fail "source repair requires a separate PAPERCUSP_WINDOWS_OUTPUT_DIR"
  if [[ -e "$PAPERCUSP_WINDOWS_OUTPUT_DIR" ]]; then
    [[ -d "$PAPERCUSP_WINDOWS_OUTPUT_DIR" ]] \
      || fail "source repair output must be a directory"
    [[ -z "$(find "$PAPERCUSP_WINDOWS_OUTPUT_DIR" -mindepth 1 -print -quit)" ]] \
      || fail "source repair output must be empty; never overwrite prior artifacts"
  fi
fi
# Resolve the cargo target dir ONCE, deterministically — this box relocates it
# via ~/.cargo/config.toml `[build] target-dir` (a shared cache on the data disk
# since 2026-09-03; read the config, never assume the path) AND src-tauri/target
# is a symlink, so a naive "$SRC_TAURI/target/..." path is wrong. Same derivation
# release-local.sh uses. The disk preflight below reserves against THIS dir, which
# is where the build writes — so the reservation lands on the same mount the Node
# cargo admission gate (scripts/lib/cargo-result.mjs diskProbePathFor) reads.
CARGO_TARGET_ROOT="$(cd "$SRC_TAURI" && cargo metadata --no-deps --format-version 1 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("target_directory",""))' 2>/dev/null || true)"
[[ -n "$CARGO_TARGET_ROOT" ]] || CARGO_TARGET_ROOT="$SRC_TAURI/target"
CROSS_EXE="$CARGO_TARGET_ROOT/$TARGET/release/papercusp-desktop.exe"

# DISK PREFLIGHT (EI-20090527288494606) — a cross-compile plus Inno packing writes
# several GB into the cargo target root (a release target tree, then the setup.exe
# + DiskSpan .bin slices per role). Fail at second zero with an actionable message
# instead of dying deep in a build log, which is how the 0.0.11 mac cut lost a
# whole role to ENOSPC and read as a mysterious hang.
# shellcheck source=lib/disk-preflight.sh
source "$HERE/lib/disk-preflight.sh"
papercusp_require_free_gb "$CARGO_TARGET_ROOT" "${PAPERCUSP_WINCROSS_MIN_FREE_GB:-12}" "Windows cross-compile + Inno packing" || exit $?
KEY_FILE="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.papercusp/signing/papercusp.key}"
KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
# Pinned tauri CLI, resolved via `npx --yes -p @tauri-apps/cli@VER` — NEVER a bare
# `npx tauri` / `npm run tauri`, which resolve node_modules/.bin/tauri (ABSENT in the
# release checkout) and die with "could not determine executable to run" (the
# attempt-8 rc=1: the updater-.sig signer step below). Same idiom as release-local.sh.
TAURI_CLI_VERSION="${PAPERCUSP_TAURI_CLI_VERSION:-${TAURI_CLI_VERSION:-2.11.0}}"
WINEPREFIX_INNO="${PAPERCUSP_WINE_INNO_PREFIX:-$HOME/.papercusp/wine-inno}"
ISCC_EXE="${PAPERCUSP_ISCC_EXE:-$WINEPREFIX_INNO/drive_c/InnoSetup6/ISCC.exe}"
WINDOWS_SIGN_DIGEST="${WINDOWS_SIGN_DIGEST:-sha256}"
WINDOWS_SIGN_TIMESTAMP_URL="${WINDOWS_SIGN_TIMESTAMP_URL-http://timestamp.digicert.com}"

# Single-file opt-in (owner-directed 2026-07-08, mirror of the VM script):
# PAPERCUSP_SINGLE_FILE=1 -> ISCC /DSingleFile -> papercusp.iss omits
# DiskSpanning even for the Server tree. Default = Server spans <2GiB slices.
SPAN_DEFINE=()
[[ "${PAPERCUSP_SINGLE_FILE:-0}" == "1" ]] && SPAN_DEFINE=("/DSingleFile")

# Producer/consumer contract guard: compile a real tiny Inno 6.7 fixture with
# the exact ISCC selected for this build, then select an extractor that can list
# its payload. A version string cannot prove compatibility; this must run before
# any cargo-xwin invocation. Export the returned absolute path so the finished-
# artifact audit consumes the exact binary that passed this probe rather than
# resolving PATH again after hours of build work.
PAPERCUSP_INNOEXTRACT="$(
  innoextract_compat_preflight "${PAPERCUSP_INNOEXTRACT:-}" "$WINEPREFIX_INNO" "$ISCC_EXE"
)" || fail "Inno extractor compatibility preflight failed — refusing to start cargo xwin"
export PAPERCUSP_INNOEXTRACT

# ── Toolchain preflight ──────────────────────────────────────────────────────
command -v cargo-xwin >/dev/null 2>&1 || command -v cargo >/dev/null 2>&1 \
  || fail "cargo not on PATH"
cargo xwin --version >/dev/null 2>&1 \
  || fail "cargo-xwin not installed (cargo install cargo-xwin) — the Windows cross toolchain"
# Capture-then-match rather than `rustup ... | grep -qx`: under `set -o pipefail` an
# early-exiting grep can SIGPIPE the producer, so the pipeline reports failure even on a
# match — refusing a toolchain that IS installed. Same fix (and same reason) as the
# win_targets_installed check in release-local.sh, and as the `grep -a` on the binary a
# few hundred lines below. Enforced by `npm run lint:pipefail-sigpipe`.
# The newline fencing preserves `grep -qx`'s whole-line-match semantics.
rustup_targets="$(rustup target list --installed 2>/dev/null || true)"
case $'\n'"$rustup_targets"$'\n' in
  *$'\n'"$TARGET"$'\n'*) ;;
  *) fail "rustup target $TARGET not installed (rustup target add $TARGET)" ;;
esac
command -v wine >/dev/null 2>&1 || fail "wine not installed (apt install wine + dpkg --add-architecture i386)"
command -v xvfb-run >/dev/null 2>&1 || fail "xvfb-run not installed (apt install xvfb) — ISCC runs headless under it"
[[ -f "$ISCC_EXE" ]] || fail "ISCC not found at $ISCC_EXE — provision Inno Setup 6.7.3 under WINEPREFIX=$WINEPREFIX_INNO"
[[ -f "$KEY_FILE" ]] || fail "updater signing key not found at $KEY_FILE (bin/setup-signing-key.sh)"

# ── Payload presence, scoped to the requested products. A GUI-only cut needs
# only the shared SPA. The full sidecar audit and WSL runtime are Server gates.
if [[ " $ROLES " == *" gui "* ]]; then
  [[ -f "$SRC_TAURI/sidecar/spa/index.html" ]] \
    || fail "GUI SPA missing — run bin/build-desktop-sidecar.sh first"
  node "$ROOT/bin/check-spa-freshness.js" \
    || fail "GUI SPA freshness check refused this build (see above)"
fi
if [[ " $ROLES " == *" server "* ]]; then
  [[ -d "$SRC_TAURI/sidecar/apps" ]] || fail "Server sidecar not built — run bin/build-desktop-sidecar.sh first"
  # "we ship it as-is" is exactly why staleness here is invisible. Require
  # proof that the final assembled Server sidecar passed its release audit.
  PAPERCUSP_REQUIRE_SIDECAR_RELEASE_AUDIT=1 \
  node "$ROOT/bin/check-sidecar-freshness.js" \
    --sidecar "$SRC_TAURI/sidecar" --repo-root "$ROOT/.." --label "sidecar-freshness:windows" \
    || fail "Server sidecar freshness check refused this build (see above)"
  [[ -f "$SRC_TAURI/resources/papercup-runtime.tar.gz" ]] \
    || fail "WSL rootfs missing — run scripts/build-rootfs.sh first"
fi
[[ -f "$SRC_TAURI/icons/icon.ico" ]] || fail "src-tauri/icons/icon.ico missing (papercusp.iss SetupIconFile)"

VERSION="${PAPERCUSP_BUILD_VERSION:-$(node -p "require('$SRC_TAURI/tauri.conf.json').version" 2>/dev/null || echo unknown)}"
if [[ -n "${PAPERCUSP_RELEASE_TAG:-}" ]]; then
  PAPERCUSP_RELEASE_CUT_START_NS="$(release_artifacts_cut_start_ensure "$PAPERCUSP_RELEASE_TAG")"
  export PAPERCUSP_RELEASE_CUT_START_NS
  echo "==> release artifact freshness: cut-start=$PAPERCUSP_RELEASE_CUT_START_NS (tag=$PAPERCUSP_RELEASE_TAG)"
fi
[[ "$VERSION" != "unknown" && -n "$VERSION" ]] || fail "could not resolve the build version (PAPERCUSP_BUILD_VERSION or tauri.conf.json)"

# Authenticode is opt-in on an owner-supplied cert (currently unset in prod, so
# a byte-identical UNSIGNED build). Materialize the PKCS#12 once if provided.
AUTHENTICODE_PFX=""
if [[ -n "${WINDOWS_CERT_BASE64:-}" ]]; then
  command -v osslsigncode >/dev/null 2>&1 || fail "WINDOWS_CERT_BASE64 set but osslsigncode not installed (apt install osslsigncode)"
  AUTHENTICODE_PFX="$(mktemp /tmp/papercusp-authenticode-XXXX.pfx)"
  printf '%s' "$WINDOWS_CERT_BASE64" | base64 -d > "$AUTHENTICODE_PFX" \
    || fail "WINDOWS_CERT_BASE64 is not valid base64"
  echo "==> Authenticode signing ENABLED (owner cert supplied)"
else
  echo "==> Authenticode signing DISABLED (no WINDOWS_CERT_BASE64) — UNSIGNED build (same as current prod)"
fi

cleanup() {
  local status="$?"
  trap - EXIT
  [[ -n "$AUTHENTICODE_PFX" && -f "$AUTHENTICODE_PFX" ]] && rm -f "$AUTHENTICODE_PFX"
  if [[ "$BUILD_WORKTREE" == "1" && -n "$BUILD_ROOT" ]]; then
    git -C "$SOURCE_ROOT" worktree remove --force "$BUILD_ROOT" >/dev/null 2>&1 \
      || rm -rf -- "$BUILD_ROOT"
  elif [[ -n "$BUILD_ROOT" && -d "$BUILD_ROOT" ]]; then
    rm -rf -- "$BUILD_ROOT"
  fi
  [[ -n "$BUILD_CONTAINER" && -d "$BUILD_CONTAINER" ]] && rm -rf -- "$BUILD_CONTAINER"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Authenticode-sign a PE in place with osslsigncode, IFF a cert was supplied
# (else a no-op — same semantics as the VM's Sign-File). Timestamp is RFC3161
# when a TS url is set; empty url => offline (no TS).
authenticode_sign() {
  local pe="$1"
  [[ -n "$AUTHENTICODE_PFX" ]] || return 0
  local tmp; tmp="$(mktemp "${pe}.signed.XXXX")"
  local ts_args=()
  [[ -n "$WINDOWS_SIGN_TIMESTAMP_URL" ]] && ts_args=(-ts "$WINDOWS_SIGN_TIMESTAMP_URL")
  echo "  authenticode: $(basename "$pe")"
  osslsigncode sign -pkcs12 "$AUTHENTICODE_PFX" -pass "${WINDOWS_CERT_PASSWORD:-}" \
    -h "$WINDOWS_SIGN_DIGEST" -n "Papercusp" "${ts_args[@]}" \
    -in "$pe" -out "$tmp" >/dev/null 2>&1 \
    || { rm -f "$tmp"; fail "osslsigncode failed to Authenticode-sign $pe"; }
  mv -f "$tmp" "$pe"
}

# Convert an absolute Linux path to the wine drive path (Z: maps to /).
winpath() { printf 'Z:%s' "$(printf '%s' "$1" | sed 's:/:\\:g')"; }

# ── Server-only source-tree + env-sidecar staging. A GUI-only cut must neither
# construct nor snapshot these runtime payloads.
# stage-source-tree.sh writes src-tauri/sidecar/source.tar.zst (the Server span
# trigger); env-sidecars/staging is the packaged env switcher's staging bundle.
# Both re-staged fresh, serialized against a concurrent sidecar publish via the
# same flock on src-tauri/sidecar.lock. The shared helper first grants a short
# startup grace, then asks only tauri-guarded readers to yield, and finally
# bounds the remaining wait with holder diagnostics.
if [[ " $ROLES " == *" server "* && -n "$SOURCE_REPAIR" ]]; then
  # A native repair consumes the frozen cut's existing generated payload.
  # The ordinary staging block below REWRITES source.tar.zst/env-sidecars;
  # that would mutate our baseline before the isolated source is even made.
  # Fail closed on missing inputs instead of reconstructing or shrinking them.
  if [[ "${PAPERCUSP_STAGE_SOURCE:-1}" == "1" ]]; then
    [[ -s "$SRC_TAURI/sidecar/source.tar.zst" ]] \
      || fail "source repair requires the frozen source.tar.zst"
  fi
  for _frozen_env_input in serve.mjs spa/index.html; do
    [[ -s "$SRC_TAURI/env-sidecars/staging/$_frozen_env_input" ]] \
      || fail "source repair requires frozen env-sidecars/staging/$_frozen_env_input"
  done
  _frozen_env_serve="$SRC_TAURI/env-sidecars/staging/serve.mjs"
  grep -Fq 'ensureOAuthStateKeyFile' "$_frozen_env_serve" \
    || fail "source repair requires the OAuth state key-file fix in frozen env-sidecars/staging/serve.mjs"
  if grep -Fq 'env2&&env2.length>=32?secretKey=Buffer.from(env2,"utf8"):secretKey=randomBytes' "$_frozen_env_serve"; then
    fail "source repair refuses the legacy per-process OAuth state random fallback in frozen env-sidecars/staging/serve.mjs"
  fi
  echo "    native repair: retaining frozen source archive and environment sidecar inputs"
elif [[ " $ROLES " == *" server "* ]]; then
  (
    __pc_acquire_sidecar_flock "$SRC_TAURI/sidecar.lock" || exit $?
    PAPERCUSP_SIDECAR_LOCK_HELD=1 bash "$ROOT/bin/stage-source-tree.sh"
    if [[ "${PAPERCUSP_STAGE_SOURCE:-1}" == "1" ]]; then
      [[ -f "$SRC_TAURI/sidecar/source.tar.zst" ]] \
        || fail "PAPERCUSP_STAGE_SOURCE=1 but stage-source-tree.sh left no sidecar/source.tar.zst"
      echo "    source.tar.zst staged ($(du -h "$SRC_TAURI/sidecar/source.tar.zst" | cut -f1)) — Server role will DiskSpan"
    fi
    # env-sidecars/staging: hardlink the primary Server payload.
    ENV_SC="$SRC_TAURI/env-sidecars/staging"
    rm -rf "$SRC_TAURI/env-sidecars"
    mkdir -p "$ENV_SC"
    cp -al "$SRC_TAURI/sidecar/serve.mjs" "$ENV_SC/serve.mjs"
    cp -al "$SRC_TAURI/sidecar/spa" "$ENV_SC/spa"
    cp -al "$SRC_TAURI/sidecar/db-sql" "$ENV_SC/db-sql"
    for extra in prompts harness; do
      [[ -d "$SRC_TAURI/sidecar/$extra" ]] && cp -al "$SRC_TAURI/sidecar/$extra" "$ENV_SC/$extra"
    done
    echo "    env-sidecars/staging staged (hardlinked)"
  ) 9>>"$SRC_TAURI/sidecar.lock"
fi

# ── Immutable build-source snapshot ─────────────────────────────────────────
# The shared checkout can change while this ~12-minute build is running: git-sync
# commits it, peers edit it, and the sidecar writer refreshes generated inputs.
# Compiling the live tree while stamping PAPERCUSP_BUILD_SHA therefore produces
# an artifact whose provenance is false. Pin the commit before any cargo work and
# compile from a private worktree so later edits cannot change the Rust source.
BUILD_COMMIT_SHA="$(git -C "$SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
BUILD_COMMIT_SHORT="$(git -C "$SOURCE_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
[[ -n "$BUILD_COMMIT_SHA" && -n "$BUILD_COMMIT_SHORT" ]] \
  || fail "could not resolve the Windows build source commit from $SOURCE_ROOT"
BUILD_SUPERPROJECT_COMMIT_SHA="$(git -C "$SUPERPROJECT_ROOT" rev-parse --verify "${PAPERCUSP_EXPECTED_SOURCE_SHA:-HEAD}^{commit}" 2>/dev/null || true)"
[[ -n "$BUILD_SUPERPROJECT_COMMIT_SHA" ]] \
  || fail "could not resolve the Windows superproject source commit from $SUPERPROJECT_ROOT"

if [[ -n "${PAPERCUSP_BUILD_SHA:-}" ]]; then
  _build_sha_label="${PAPERCUSP_BUILD_SHA%-dirty}"
  case "$BUILD_COMMIT_SHA" in
    "$_build_sha_label"*) ;;
    *) fail "PAPERCUSP_BUILD_SHA='${PAPERCUSP_BUILD_SHA}' does not identify source HEAD ${BUILD_COMMIT_SHORT} — refusing a mislabeled Windows build" ;;
  esac
else
  export PAPERCUSP_BUILD_SHA="$BUILD_COMMIT_SHORT"
fi

BUILD_CONTAINER="$(mktemp -d /tmp/papercusp-win-cross-source-XXXXXX)"
BUILD_ROOT="$BUILD_CONTAINER/papercusp-desktop"
if ! git -C "$SOURCE_ROOT" worktree add --detach "$BUILD_ROOT" "$BUILD_COMMIT_SHA" >/dev/null 2>&1; then
  fail "could not create the isolated Windows build source at $BUILD_ROOT"
fi
BUILD_WORKTREE=1
PROVENANCE_TOOLS_ROOT="$BUILD_CONTAINER/provenance-tools"
WINDOWS_PROVENANCE_TOOLCHAIN="$(snapshot_provenance_tools "$PROVENANCE_TOOLS_ROOT" "$HERE")" \
  || fail "could not snapshot the Windows provenance producer"
SOURCE_REPAIR_APPLIED=""

# A release cut intentionally edits its version manifests before the build and
# generates the seed/sidecar outside Git. Copy those inputs once into the pinned
# worktree; do not copy arbitrary source edits, which would reopen the race this
# snapshot closes. The generated trees are staged under their own writer lock and
# are copied only after staging completes.
copy_snapshot_input() {
  local rel="$1" source="$SOURCE_ROOT/$1" dest="$BUILD_ROOT/$1"
  [[ -e "$source" || -L "$source" ]] || fail "required Windows build input is missing: $source"
  rm -rf -- "$dest"
  mkdir -p -- "$(dirname "$dest")"
  cp -a --reflink=auto -- "$source" "$dest"
}

# custom_protocol.rs consumes this superproject-owned policy at compile time via
# ../../../libs from src-tauri/src. The immutable boundary therefore includes
# more than the papercusp-desktop repository: stage the exact committed policy
# blob beside the private worktree so the relative include resolves without
# reading mutable canonical-tree bytes.
WINDOWS_CSP_POLICY_REL="libs/generic/desktop-ipc/src/csp-policy.json"
copy_superproject_snapshot_blob() {
  local rel="$1" dest="$BUILD_CONTAINER/$1" expected_blob actual_blob
  local source_repo="$SUPERPROJECT_ROOT" source_commit="$BUILD_SUPERPROJECT_COMMIT_SHA"
  local source_path="" component tree_entry entry_mode entry_type entry_path
  local -a components
  IFS=/ read -r -a components <<< "$rel"
  for component in "${components[@]}"; do
    source_path="${source_path:+$source_path/}$component"
    tree_entry="$(git -C "$source_repo" --literal-pathspecs ls-tree "$source_commit" -- "$source_path")" \
      || fail "could not resolve required Windows superproject input: $rel"
    read -r entry_mode entry_type expected_blob entry_path <<< "$tree_entry"
    [[ -n "$expected_blob" ]] \
      || fail "required Windows superproject input is not tracked at $source_commit: $rel"
    if [[ "$entry_mode" == 160000 && "$entry_type" == commit ]]; then
      source_repo="$source_repo/$source_path"
      source_commit="$expected_blob"
      source_path=""
      [[ -e "$source_repo/.git" ]] \
        || fail "required Windows submodule source repository is unavailable: $source_repo"
      git -C "$source_repo" cat-file -e "$source_commit^{commit}" 2>/dev/null \
        || fail "required Windows submodule source commit is unavailable: $source_commit ($source_repo)"
    elif [[ "$entry_type" != tree && "$entry_mode" != 100644 && "$entry_mode" != 100755 ]]; then
      fail "required Windows superproject input is not a regular blob: $rel"
    fi
  done
  [[ "$entry_type" == blob && ( "$entry_mode" == 100644 || "$entry_mode" == 100755 ) ]] \
    || fail "required Windows superproject input is not a regular blob: $rel"
  mkdir -p -- "$(dirname "$dest")"
  git -C "$source_repo" cat-file blob "$expected_blob" > "$dest" \
    || fail "could not materialize frozen Windows superproject input: $rel"
  actual_blob="$(git -C "$source_repo" hash-object "$dest" 2>/dev/null || true)"
  [[ "$actual_blob" == "$expected_blob" ]] \
    || fail "frozen Windows superproject input hash mismatch: $rel"
}

for _release_input in package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json; do
  copy_snapshot_input "$_release_input"
done
# Compose only AFTER the frozen release-version inputs arrive. Otherwise this
# copy silently overwrites an admitted direct dependency with the old manifest.
# The v2 helper validates that version stamping is the ONLY baseline difference.
if [[ -n "$SOURCE_REPAIR" ]]; then
  SOURCE_REPAIR_APPLIED="$BUILD_CONTAINER/source-repair.json"
  node "$PROVENANCE_TOOLS_ROOT/lib/windows-source-repair.js" apply "$SOURCE_REPAIR" \
    "${PAPERCUSP_WINDOWS_SOURCE_REPAIR_REPO:-$SOURCE_ROOT}" "$BUILD_ROOT" \
    "$BUILD_COMMIT_SHA" "$BUILD_SUPERPROJECT_COMMIT_SHA" "$ROLES" >"$SOURCE_REPAIR_APPLIED" \
    || fail "source repair failed exact committed-source validation"
  echo "==> DERIVED Windows native source ($ROLES); buildSha identifies the paired operator base, not the repaired native source"
fi
copy_superproject_snapshot_blob "$WINDOWS_CSP_POLICY_REL"
if [[ " $ROLES " == *" server "* ]]; then
  for _generated_input in src-tauri/sidecar src-tauri/env-sidecars src-tauri/seed src-tauri/resources; do
    copy_snapshot_input "$_generated_input"
  done
else
  # Fail closed: a GUI-only snapshot contains no path from which Inno could
  # accidentally sweep Server assets. Preserve only the generated SPA.
  rm -rf -- \
    "$BUILD_ROOT/src-tauri/sidecar" \
    "$BUILD_ROOT/src-tauri/resources" \
    "$BUILD_ROOT/src-tauri/seed" \
    "$BUILD_ROOT/src-tauri/env-sidecars"
  copy_snapshot_input "src-tauri/sidecar/spa"
fi

# ROOT/SRC_TAURI now name the immutable source. OUTPUT_SRC_TAURI remains the
# canonical shared output tree consumed by release-local.sh after this process
# exits; artifacts must not disappear with the temporary worktree.
ROOT="$BUILD_ROOT"
SRC_TAURI="$ROOT/src-tauri"
echo "==> isolated Windows build source: commit=${BUILD_COMMIT_SHORT} root=$BUILD_ROOT"

# ── Stage dir the .iss reads via {#BuildRoot}. papercusp.iss wants the exe at
# {BuildRoot}\target\release\papercusp-desktop.exe and sibling dirs sidecar,
# resources, seed, env-sidecars, icons, windows. We symlink the src-tauri dirs
# (wine follows them) and drop the freshly-compiled per-role exe into
# target/release/ just before each pack.
STAGE="$(mktemp -d /tmp/win-cross-stage-XXXX)"
OUT_DIR="$OUTPUT_SRC_TAURI/target/windows-vm/bundle/inno"   # the dir release-local.sh collects from
if [[ -n "${PAPERCUSP_WINDOWS_OUTPUT_DIR:-}" ]]; then
  OUT_DIR="$PAPERCUSP_WINDOWS_OUTPUT_DIR"
fi
mkdir -p "$STAGE/target/release" "$OUT_DIR"
for d in sidecar resources seed env-sidecars icons windows; do
  [[ -e "$SRC_TAURI/$d" ]] && ln -sfn "$SRC_TAURI/$d" "$STAGE/$d"
done
ISS_WIN="$(winpath "$SRC_TAURI/windows/inno/papercusp.iss")"
BUILDROOT_WIN="$(winpath "$STAGE")"
# Clean stale collected artifacts (files only; keep any prev-version subdirs).
find "$OUT_DIR" -maxdepth 1 -type f -delete

# ── WI-10003673: precompute the Server's hot-runtime generation ──────────────
# Without it the installed launcher SHA-256s the whole ~5 GB {app}\sidecar on
# EVERY boot before its snapshot marker probe (~9 min on the VM). Hash the
# pinned snapshot here, in the layout papercusp.iss installs (sidecar\* plus the
# env-sidecars overlay), bound to this build's .sidecar-build-stamp. The .iss
# ships the record as {app}\sidecar\.sidecar-runtime-generation (Server only,
# LAST [Files] entry) and fails compilation if it is missing.
if [[ " $ROLES " == *" server "* ]]; then
  _generation_mounts=()
  [[ -d "$SRC_TAURI/env-sidecars" ]] \
    && _generation_mounts=(--mount "env-sidecars=$SRC_TAURI/env-sidecars")
  node "$ROOT/bin/lib/sidecar-runtime-generation.js" \
      --sidecar "$SRC_TAURI/sidecar" "${_generation_mounts[@]}" \
      --installer-script "$SRC_TAURI/windows/inno/papercusp.iss" \
      --out "$STAGE/.sidecar-runtime-generation" \
    || fail "could not precompute the Windows sidecar runtime generation (WI-10003673)"
fi

# ── Per-role: cross-compile -> stage exe -> ISCC-under-wine -> collect ────────
run_iscc() {
  local app_id="$1" app_name="$2"
  local -a _iscc_rcs
  local out_win; out_win="$(winpath "$STAGE/out")"
  rm -rf "$STAGE/out"; mkdir -p "$STAGE/out"
  echo "  ISCC (wine, headless): $app_name"
  # winemenubuilder.exe=d: wine's menubuilder otherwise registers .desktop entries
  # into the HOST's GNOME app grid (~/.local/share/applications/wine/Programs/).
  # On the dev box that lands "Papercusp GUI"/"Papercusp Server" right beside the
  # real "Papercusp Dev" launcher, and agents/owner then verify a PACKAGED build
  # instead of `npm run dev` — which says nothing about their working-tree edit.
  # An explicit WINEDLLOVERRIDES here would override the global default set in
  # ~/.config/environment.d/90-wine-no-menubuilder.conf, so it must repeat it.
  # The filter is presentation-only. Capture both pipeline statuses before any
  # other command overwrites PIPESTATUS so an ISCC failure cannot be converted
  # to success merely because grep ran (or because a partial/stale artifact was
  # left behind). grep exit 1 means every line was filtered and is benign;
  # grep exit >=2 is an actual filtering failure.
  set +e
  WINEPREFIX="$WINEPREFIX_INNO" WINEDEBUG=-all WINEDLLOVERRIDES="mscoree=d;mshtml=d;winemenubuilder.exe=d" \
    xvfb-run -a wine "$ISCC_EXE" \
      "/DAppId=$app_id" "/DAppName=$app_name" "/DAppVersion=$VERSION" \
      "/DBuildRoot=$BUILDROOT_WIN" "/O$out_win" \
      "${SPAN_DEFINE[@]}" "$ISS_WIN" 2>&1 \
    | grep -vE '^\s*Compressing'
  _iscc_rcs=("${PIPESTATUS[@]}")
  set -e
  (( _iscc_rcs[1] <= 1 )) \
    || fail "ISCC output filter failed for role '$app_name' (grep exit ${_iscc_rcs[1]})"
  (( _iscc_rcs[0] == 0 )) \
    || fail "ISCC failed for role '$app_name' (exit ${_iscc_rcs[0]}) — refusing any artifact left by the failed compiler"
  # Move every produced artifact (setup.exe [+ *-setup-N.bin span slices]) to OUT_DIR.
  local moved=0 f
  shopt -s nullglob
  for f in "$STAGE/out/${app_name}_${VERSION}_x64-setup.exe" "$STAGE/out/${app_name}_${VERSION}_x64-setup-"*.bin; do
    [[ -e "$f" ]] || continue
    mv -f "$f" "$OUT_DIR/"; moved=1
  done
  shopt -u nullglob
  [[ "$moved" == "1" ]] || fail "ISCC produced no artifact for role '$app_name' (expected ${app_name}_${VERSION}_x64-setup.exe in $STAGE/out)"
}

for role in $ROLES; do
  case "$role" in
    gui)    app_id="com.papercusp.gui";    app_name="Papercusp GUI";    tauri_cfg="" ;;
    server) app_id="com.papercusp.server"; app_name="Papercusp Server"; tauri_cfg="$SRC_TAURI/tauri.server.conf.json" ;;
    *) echo "WARN: unknown role '$role' — skipping" >&2; continue ;;
  esac
  echo "==> [$role] cross-compiling papercusp-desktop.exe ($TARGET)"
  # TAURI_CONFIG merges tauri.server.conf.json over tauri.conf.json at BOTH
  # build.rs (tauri_build) and generate_context!() time, baking the server
  # identifier/productName — the mechanism `tauri build --config` uses.
  # tauri_build emits rerun-if-env-changed=TAURI_CONFIG, so switching roles
  # re-runs generate_context! (final-crate relink only, deps stay warm).
  # Explicit GUI override prevents an inherited TAURI_CONFIG from compiling a
  # Server binary while the requested role/provenance says GUI.
  cfg_env=(TAURI_CONFIG='{}')
  [[ -n "$tauri_cfg" ]] && cfg_env=(TAURI_CONFIG="$(cat "$tauri_cfg")")
  if [[ -n "$SOURCE_REPAIR_APPLIED" ]]; then
    repair_cfg="$(node "$PROVENANCE_TOOLS_ROOT/lib/windows-source-repair.js" config \
      "$SOURCE_REPAIR_APPLIED" "$ROOT" "$role")" \
      || fail "source repair compile configuration does not identify $role"
    cfg_env=(TAURI_CONFIG="$repair_cfg")
  fi
  ( cd "$SRC_TAURI" && env \
      "PAPERCUSP_BUILD_SHA=${PAPERCUSP_BUILD_SHA:-}" \
      "PAPERCUSP_BUILD_VERSION=${PAPERCUSP_BUILD_VERSION:-}" \
      "PAPERCUSP_RELEASE_HOST=${PAPERCUSP_RELEASE_HOST:-}" \
      "${cfg_env[@]}" \
      "RUSTFLAGS=${RUSTFLAGS:-} $_WIN_REMAP $_WIN_CRT_STATIC" \
      cargo xwin build --release --locked --target "$TARGET" -p papercusp-desktop )
  EXE="$CROSS_EXE"
  [[ -f "$EXE" ]] || fail "cross-compile produced no papercusp-desktop.exe for role '$role' at $EXE"

  # ── Guard: the shipped binary must not import the VC++ runtime (WI-39375) ────
  # THE RECURRENCE GUARD for WI-39372. A green build is NOT evidence here: builds
  # already succeeded for every release that shipped this bug, because the build
  # host always has the DLL. The only honest check is a property of the ARTIFACT,
  # so read the PE import table of the binary we just produced.
  #
  # Placed in the build script rather than a unit test on purpose: no test that
  # runs in the build environment can observe this class — the dependency is
  # created at link time and satisfied by nothing at install time, and the build
  # box satisfies it by accident. This is also why it asserts on $EXE (the thing
  # we ship) instead of re-reading the config that was supposed to cause it.
  _imports="$( { llvm-readobj --coff-imports "$EXE" 2>/dev/null \
                 || x86_64-w64-mingw32-objdump -p "$EXE" 2>/dev/null \
                 || strings -a "$EXE" 2>/dev/null; } | tr 'A-Z' 'a-z' )"
  if [[ -z "$_imports" ]]; then
    fail "crt-static guard: could not read imports of $EXE (need llvm-readobj, objdump or strings) — refusing to ship an unverified Windows binary"
  fi
  if printf '%s' "$_imports" | grep -qE 'vcruntime140|msvcp140|api-ms-win-crt'; then
    fail "crt-static guard FAILED: $EXE still imports the VC++ runtime (vcruntime140/msvcp140/api-ms-win-crt).
This binary will install fine and then FAIL AT FIRST LAUNCH on any clean Windows
that lacks the redistributable — the exact WI-39372 defect. Most likely cause: a
caller exported RUSTFLAGS and suppressed \$_WIN_CRT_STATIC, or .cargo/config.toml
was relied on while an env RUSTFLAGS was set (those sources are mutually
exclusive — see the _WIN_CRT_STATIC comment above)."
  fi
  echo "  [crt-static] OK — $role: no VC++ runtime imports in $(basename "$EXE")"

  # ── Identity: scrub the ONE path --remap-path-prefix cannot reach ────────────
  # _WIN_REMAP takes this binary from 359 leaked $HOME occurrences to exactly 1.
  # The survivor is tauri's permission/ACL codegen baking an absolute
  # CARGO_MANIFEST_DIR via env!(), which remap never rewrites (it only rewrites
  # rustc SOURCE paths) — the same residue, same cause, as macOS
  # (EI-20044309663936316). PE/COFF retains it because, unlike the ELF link, it
  # does not dead-strip the unreferenced rodata string.
  #
  # ⚠ ORDERING INVARIANT — this MUST run BEFORE run_iscc() packs the exe.
  # Scrubbing after packaging is useless: the installer already carries the
  # leaky bytes. (On mac this exact call once sat in sign_app(), which runs
  # AFTER the identity scan, so it never executed and the 0.0.14 cut died with
  # the leak intact — placement, not presence, is what makes it work.)
  # Length-preserving, so every PE offset stays valid: verified on this binary
  # at 22,564,864 bytes in and out, leak 1 -> 0, still `PE32+ executable (GUI)`.
  # ⚠ MITIGATION, not a fix — the dead-strip root cause is EI-20044309663936316.
  python3 "$HERE/audit-release-bundle.py" --scrub-app-binary "$EXE" \
    || fail "scrub-app-binary failed for $EXE — refusing to package a binary carrying build-box identity"

  # Assert the release host was actually baked (the 0.0.8 defect: an empty host
  # compiles fine and the updater reads it as "up to date" forever).
  # grep the binary directly (-a) rather than `strings … | grep -q`: under
  # `set -o pipefail`, grep -q exits on first match and SIGPIPEs strings (141),
  # which pipefail then propagates as a spurious failure whenever the host IS
  # present — the exact inversion of what the guard is checking.
  if [[ -n "${PAPERCUSP_RELEASE_HOST:-}" ]]; then
    grep -aqF "$PAPERCUSP_RELEASE_HOST" "$EXE" \
      || fail "[$role] PAPERCUSP_RELEASE_HOST='$PAPERCUSP_RELEASE_HOST' is NOT baked into the exe — cargo cached a stale/empty host. Clean the crate and rebuild."
  fi

  # Authenticode-sign the app exe BEFORE Inno packs it (mirror of the VM: sign
  # the payload exe, then the setup.exe after). No-op without a cert.
  cp -f "$EXE" "$STAGE/target/release/papercusp-desktop.exe"
  authenticode_sign "$STAGE/target/release/papercusp-desktop.exe"

  # ── Identity: scan the assembled Windows payload BEFORE Inno packs it ───────
  # The BuildRoot is intentionally made from symlinks above; grep -r (which the
  # audit uses) does not descend into symlinked directories, so scanning "$STAGE"
  # would inspect the exe but silently skip the sidecar/resources/seed bytes that
  # Inno follows and ships. Point at the real assembled inputs instead. The GUI's
  # source.tar.zst is independently audited by stage-source-tree.sh and is not
  # included by papercusp.iss; the Server root includes it here via sidecar/.
  _WIN_SCAN_DIRS=("$STAGE/target/release")
  if [[ "$role" == "gui" ]]; then
    _WIN_SCAN_DIRS+=("$SRC_TAURI/sidecar/spa")
  else
    _WIN_SCAN_DIRS+=("$SRC_TAURI/sidecar" "$SRC_TAURI/resources")
    _WIN_SCAN_DIRS+=("$SRC_TAURI/seed" "$SRC_TAURI/env-sidecars/staging")
  fi
  # Exit 2 (COULD NOT CHECK) and exit 1 (FOUND LEAKS) must not share a message. Both
  # stop the build — this is a diagnosability fix, not a safety one — but reporting a
  # blind gate as "carries sensitive identity" sends you hunting a leak that is not
  # there while the real fault is that nothing was hunted (EI-20583328178472869).
  set +e
  python3 "$HERE/audit-release-bundle.py" --scan-dir "${_WIN_SCAN_DIRS[@]}"
  _audit_rc=$?
  set -e
  if [[ $_audit_rc -eq 2 ]]; then
    fail "[$role] identity audit COULD NOT CHECK — it did NOT find a leak. Almost always: no owner-name literal resolved, because git user.name is unset or belongs to an automation. Export PAPERCUSP_RELEASE_OWNER_NAME (and PAPERCUSP_RELEASE_OWNER_EMAIL; both take a comma-separated list) and re-run. Read at run time — never write either into a file."
  elif [[ $_audit_rc -ne 0 ]]; then
    fail "[$role] assembled Windows payload carries sensitive identity (see scan above) — refusing to package a leaky installer"
  fi

  echo "==> [$role] packing installer with Inno Setup under wine"
  run_iscc "$app_id" "$app_name"
done

# ── Size + span sanity (mirror of the VM collection asserts) ─────────────────
shopt -s nullglob
for f in "$OUT_DIR"/*-setup.exe; do
  size=$(stat -c%s "$f")
  if (( size > 4290772992 )); then
    fail "$(basename "$f") is $((size/1024/1024))MB — exceeds Inno's ~4GB single-exe max (WI-3172); the Server tree must DiskSpan (do not set PAPERCUSP_SINGLE_FILE=1 for a full-seed Server build)"
  elif (( size > 3900000000 )); then
    echo "WARN: $(basename "$f") is $((size/1024/1024))MB — within ~10% of Inno's ~4GB single-exe max (WI-3172)" >&2
  fi
done
if [[ "${PAPERCUSP_STAGE_SOURCE:-1}" == "1" && "${PAPERCUSP_SINGLE_FILE:-0}" != "1" && " $ROLES " == *" server "* ]]; then
  compgen -G "$OUT_DIR/*Server*-setup-*.bin" > /dev/null \
    || fail "Server role built with PAPERCUSP_STAGE_SOURCE=1 but no *-setup-*.bin slices — DiskSpanning didn't engage (source.tar.zst missing from the BuildRoot?)"
fi
shopt -u nullglob

# Retain verified native-source evidence BEFORE the finished-container gates.
# A later packaging refusal must remain a refusal, but must not erase which
# native bytes were compiled when cleanup removes the disposable source tree.
# This is unsigned evidence, not a successful build or release acceptance.
emit_windows_provenance() {
  local phase="$1" signed="$2" toolchain
  local -a artifacts
  shopt -s nullglob
  artifacts=("$OUT_DIR"/*-setup.exe "$OUT_DIR"/*-setup-*.bin)
  shopt -u nullglob
  [[ ${#artifacts[@]} -gt 0 ]] || fail "no Windows artifacts for source evidence"
  if [[ -n "$SOURCE_REPAIR_APPLIED" ]]; then
    node "$PROVENANCE_TOOLS_ROOT/lib/windows-source-repair.js" verify "$SOURCE_REPAIR_APPLIED" "$ROOT" "$ROLES" >/dev/null \
      || fail "native source changed after repair materialization"
    cp "$SOURCE_REPAIR_APPLIED" "$OUT_DIR/source-repair.json"
  fi
  cp "$PROVENANCE_TOOLS_ROOT/producer-inputs.json" "$OUT_DIR/producer-inputs.json"
  toolchain="$(node -e 'process.stdout.write(JSON.stringify({...JSON.parse(process.argv[1]), windowsBuildPhase:process.argv[2]}))' \
    "$WINDOWS_PROVENANCE_TOOLCHAIN" "$phase")" || fail "invalid Windows source-evidence toolchain"
  PROVENANCE_GIT_ROOT="$ROOT" \
  PROVENANCE_SIGNED="$signed" \
  PROVENANCE_SIDECAR_DIR="$SRC_TAURI/sidecar" \
  PROVENANCE_SOURCE_REPAIR_MANIFEST="$SOURCE_REPAIR_APPLIED" \
  PROVENANCE_SOURCE_REPAIR_ROLES="$ROLES" \
  PROVENANCE_TOOLCHAIN="$toolchain" \
    bash "$PROVENANCE_TOOLS_ROOT/emit-build-provenance.sh" \
      "$OUT_DIR" "$VERSION" "${PAPERCUSP_BUILD_SHA:-}" false "${artifacts[@]}"
}
if [[ -n "$SOURCE_REPAIR_APPLIED" ]]; then
  emit_windows_provenance native-built-awaiting-artifact-audit false
fi

# ── Identity-scan the FINISHED installers (WI-39458) ─────────────────────────
# The --scan-dir pass above runs BEFORE Inno packs, so it can only ever see the
# pre-package tree. Two things then escape it, and both shipped in 0.0.17:
#   • bytes that do not exist yet at scan time — ISCC writes the installer after
#     the gate has already reported clean;
#   • the container itself — handed a finished installer, --scan-dir greps it as
#     opaque bytes and expands ZERO archives, so it reported "✓ CLEAN … 0
#     archive(s) expanded" on a 2.2GB installer whose payload was in fact dirty.
# --scan-artifact expands the container (innoextract follows the -setup-N.bin
# DiskSpan slices from the stub) and FAILS CLOSED if it cannot, so "not
# inspected" can no longer read as "clean".
#
# Deliberately placed BEFORE signing: a leaky installer must never acquire a
# signature that makes it look endorsed.
echo "==> identity-scan of the finished installer(s)"
shopt -s nullglob
_FINISHED_INSTALLERS=("$OUT_DIR"/*-setup.exe)
shopt -u nullglob
if (( ${#_FINISHED_INSTALLERS[@]} == 0 )); then
  fail "no *-setup.exe in $OUT_DIR to scan — packing produced nothing, or OUT_DIR is wrong"
fi
for _finished_installer in "${_FINISHED_INSTALLERS[@]}"; do
  _runtime_scan_args=()
  # EI-22656004539777797: the native Server reads this stamp before WSL
  # staging. Check FINISHED bytes during the existing expansion, before they
  # gain a signature. The GUI deliberately has no Server runtime.
  if [[ "$(basename "$_finished_installer")" == "Papercusp Server_${VERSION}_x64-setup.exe" ]]; then
    _runtime_scan_args+=(--require-windows-server-runtime)
  fi
  set +e
  PAPERCUSP_INNOEXTRACT="$PAPERCUSP_INNOEXTRACT" \
    python3 "$HERE/audit-release-bundle.py" --scan-artifact "${_runtime_scan_args[@]}" "$_finished_installer"
  _artifact_rc=$?
  set -e
  if [[ $_artifact_rc -eq 2 ]]; then
    fail "finished-installer audit COULD NOT CHECK — no owner-name literal or readable complete container; refusing to publish bytes nobody read"
  elif [[ $_artifact_rc -ne 0 ]]; then
    fail "finished Windows installer failed identity or required runtime closure audit (see above) — refusing to sign or publish it"
  fi
done

# ── Sign the setup.exe(s): Authenticode (cert-conditional) THEN the host-side
# updater .sig (ed25519/minisign) that the shipped auto-updater verifies.
echo "==> signing installers"
shopt -s nullglob
SETUP_EXES=("$OUT_DIR"/*-setup.exe)
shopt -u nullglob
[[ ${#SETUP_EXES[@]} -gt 0 ]] || fail "no *-setup.exe in $OUT_DIR after packing"
for SETUP_EXE in "${SETUP_EXES[@]}"; do
  authenticode_sign "$SETUP_EXE"
  echo "  updater .sig: $(basename "$SETUP_EXE")"
  # Strip the two signing env vars a newer tauri CLI hard-rejects alongside
  # --private-key-path, so ONLY the explicit key path is seen (2026-07-08 fix).
  ( cd "$ROOT" && env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PATH \
      npx --yes -p @tauri-apps/cli@"$TAURI_CLI_VERSION" tauri signer sign --private-key-path "$KEY_FILE" --password "$KEY_PASSWORD" "$SETUP_EXE" >/dev/null )
  [[ -f "$SETUP_EXE.sig" ]] || fail "tauri signer produced no .sig for $SETUP_EXE"
done

# Replace unsigned evidence only after all gates and signatures succeeded.
emit_windows_provenance artifact-audited-and-signed "$([[ -n "$AUTHENTICODE_PFX" ]] && echo true || echo false)"

# A direct/windows-only build does not pass through release-local.sh's
# collection step, so it must normalize its own Server span before returning.
# Keep the raw files for provenance/debugging, but fail closed if the span was
# detected and could not be converted to the one bundle that can be shipped.
if papercusp_normalize_spanned_server "$OUT_DIR" "$VERSION"; then
  echo "==> [win] spanned Server normalized → $(basename "$PAPERCUSP_SPANNED_SERVER_ZIP") ($(du -h "$PAPERCUSP_SPANNED_SERVER_ZIP" | cut -f1); stub + ${#PAPERCUSP_SPANNED_SERVER_SLICES[@]} slice(s); $([[ -n "$PAPERCUSP_SPANNED_SERVER_ZIP_SIG" ]] && echo "signed" || echo "UNSIGNED — see warning above"))"
elif [[ -n "$PAPERCUSP_SPANNED_SERVER_STUB" && ${#PAPERCUSP_SPANNED_SERVER_SLICES[@]} -gt 0 ]]; then
  fail "spanned Server installer detected but normalization failed (zip missing or failed) — refusing to leave a raw stub+slices set as the direct-build result"
fi

# Keep the finished Inno output and the Cargo target that produced it stable
# until the owning cut explicitly releases its retention lease.
papercusp_retain_release_paths "$CARGO_TARGET_ROOT" "$OUT_DIR" \
  || fail "could not retain finished Windows release paths"

rm -rf "$STAGE"
echo "==> done — Windows artifacts (cross-built, no VM) in $OUT_DIR"
ls -lh "$OUT_DIR"
exit 0

}  # ── end self-read guard (WI-3306) ──
