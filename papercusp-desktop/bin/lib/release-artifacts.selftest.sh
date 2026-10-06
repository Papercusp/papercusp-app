#!/usr/bin/env bash
# release-artifacts.selftest.sh — focused unit test for release-artifacts.sh, the
# single-source-of-truth artifact set the two halves of the release pipeline share
# (EI-12913). It proves, hermetically (synthetic files in a temp dir — NO real cut,
# NO VM, NO network, ~1s):
#   1. write -> read carries every DiskSpanning Server `.bin` slice (gap 2: the old
#      upload glob's extension allowlist EXCLUDED `.bin`, dropping the ~4 GB payload)
#      AND the inno-tree .exe/.sig (gap 1: the old glob scanned the WRONG tree with
#      no `inno` dir) — i.e. the windows artifacts flow through the manifest, not a
#      second, drifting glob.
#   2. read drops a vanished file and de-duplicates.
#   3. read FAILS HARD when there is no manifest — it never silently falls back to a
#      re-derived glob (that fallback IS the drift this fix removes).
#   4. the recurrence guard PASSES when latest.json only advertises covered artifacts.
#   5. the recurrence guard FAILS when latest.json advertises an artifact the upload
#      set does not carry (the LABELED != PACKED class, caught BEFORE upload).
#   6. Linux incremental discovery prefers build-linux-local.sh's source-tree
#      collection destination, with Cargo's target retained only as a legacy fallback.
#   7. a missing/malformed cut-start stamp fails closed, and every artifact must
#      be strictly newer than the stamp (stale + fresh controls).
#
#   bash bin/lib/release-artifacts.selftest.sh      # exit 0 = PASS, 1 = FAIL
#
# Why a bash self-test and not Vitest: the unit under test is bash. The desktop
# package tests its sourced bash helpers this way (see federation-asserts.selftest.sh);
# the four canonical TS/Cargo/LLM frameworks don't host shell units, and this
# submodule is not part of the operator's hoisted vitest workspace.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-artifacts.sh
source "$DIR/release-artifacts.sh"
# shellcheck source=inno-spanned-server.sh
source "$DIR/inno-spanned-server.sh"
set +e   # this self-test owns its own exit codes (some asserts intentionally fail a call)

command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 unavailable"; exit 0; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

WORK="$(mktemp -d /tmp/relart-selftest.XXXXXX)"
# Keep lease and audit state hermetic; release-artifacts.sh defaults to the
# user's durable retention directory in production.
RETENTION_ROOT="$WORK/retention"
export PAPERCUSP_RELEASE_RETENTION_ROOT="$RETENTION_ROOT"
export PAPERCUSP_RELEASE_DELETION_AUDIT_PATH="$RETENTION_ROOT/deletion-audit.tsv"
LATEST_WINDOWS_SMOKE="$RETENTION_ROOT/latest-windows-smoke.json"
# Unique tags so the /tmp manifests can't collide with a real cut or a parallel run.
TAG="desktop-v0.0.0-selftest-$$"
TAG_EMPTY="desktop-v0.0.0-selftest-empty-$$"
TAG_FRESH="desktop-v0.0.0-selftest-fresh-$$"
TAG_GUARD="desktop-v0.0.0-selftest-guard-$$"
TAG_SMOKE="desktop-v0.0.0-selftest-smoke-$$"
export PAPERCUSP_SMOKE_RECEIPT_ROOT="$WORK/smoke-receipts"
# WI-10004052: the automatic-runner cases below prove the VERIFIER PROTOCOL with a
# fake verifier and no VM. The Linux leg's clean-room VM lifecycle is covered by
# test/linux-platform-smoke-vm.test.js (fake vmctl). Switch it off here and point
# vmctl at nothing, so an ambient PAPERCUSP_LINUX_SMOKE_BASELINE_* in the caller's
# shell can never make this selftest reset the real Linux test VM.
export PAPERCUSP_LINUX_SMOKE_VM_MANAGED=0
export PAPERCUSP_LINUX_VMCTL="$WORK/vmctl-must-not-run"
unset PAPERCUSP_LINUX_SMOKE_BASELINE_GUI PAPERCUSP_LINUX_SMOKE_BASELINE_SERVER \
      PAPERCUSP_LINUX_SMOKE_BASELINE_DIR PAPERCUSP_LINUX_SMOKE_VM
cleanup() {
  rm -rf "$WORK"
  rm -f "$(release_artifacts_manifest_path "$TAG")" "$(release_artifacts_manifest_path "$TAG_EMPTY")" "$(release_artifacts_manifest_path "$TAG_FRESH")" "$(release_artifacts_cut_start_path "$TAG_FRESH")"
}
trap cleanup EXIT

VER="9.9.9"
INNO="$WORK/inno"; LINUX="$WORK/linux"
mkdir -p "$INNO" "$LINUX"
# The Server installer + its DiskSpanning slices (the shape that broke): a stub .exe
# plus TWO .bin slices carrying the payload, plus the .sig; and a linux .deb.
EXE="$INNO/Papercusp Server_${VER}_x64-setup.exe"
SIG="$INNO/Papercusp Server_${VER}_x64-setup.exe.sig"
BIN1="$INNO/Papercusp Server_${VER}_x64-setup-1.bin"
BIN2="$INNO/Papercusp Server_${VER}_x64-setup-2.bin"
DEB="$LINUX/Papercusp_${VER}_amd64.deb"
for f in "$EXE" "$SIG" "$BIN1" "$BIN2" "$DEB"; do : > "$f"; done

echo "release-artifacts self-test (tag=$TAG)"

# 0a) all three Windows entry points source and invoke the same helper. This is
# a static wiring guard: a green helper unit alone would not catch a caller
# silently bypassing it again.
#
# The source line is matched on the LIB PATH, not on one hard-coded spelling of
# the directory variable. release-local.sh deliberately keeps two of them —
# ORCHESTRATOR_HERE (from BASH_SOURCE, the real script dir) and HERE (from $0),
# because an exact-source salvage cut sources this file with $0 pointed at a
# frozen target tree — and it sources the helper via ORCHESTRATOR_HERE. Pinning
# the guard to the literal `$HERE/` spelling therefore failed a caller that is
# correctly wired, which is a false red on the shared gate rather than a caught
# bypass.
wiring_re='source[[:space:]]+"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/lib/inno-spanned-server\.sh"'
for script in \
  "$DIR/../build-windows-cross.sh" \
  "$DIR/../publish-platform-incremental.sh" \
  "$DIR/../release-local.sh"; do
  if grep -Eq "$wiring_re" "$script" \
     && grep -Fq 'papercusp_normalize_spanned_server' "$script"; then
    ok "$(basename "$script") uses shared Server span normalization"
  else
    bad "$(basename "$script") bypasses shared Server span normalization"
  fi
done

# Both publish handoffs must call the same automatic verifier runner. A correct
# receipt assertion with one caller that only checks for a manually-created
# receipt would leave the normal publish path non-self-driving again.
for script in \
  "$DIR/../publish-platform-incremental.sh" \
  "$DIR/../upload-release.sh"; do
  if grep -Fq 'release_artifacts_run_smoke_receipts' "$script"; then
    ok "$(basename "$script") runs the shared platform smoke verifier"
  else
    bad "$(basename "$script") bypasses the automatic platform smoke verifier"
  fi
done

# 0a-CONTROL: the wiring guard must still FAIL a genuine bypass. Without this a
# regex that matches nothing — or everything — reads as a clean pass.
_wiring_probe="$(mktemp)"
printf 'papercusp_normalize_spanned_server "$@"\n' > "$_wiring_probe"
if grep -Eq "$wiring_re" "$_wiring_probe"; then
  bad "CONTROL: wiring guard PASSED a script that never sources the helper"
else
  ok "CONTROL: wiring guard still fails a caller that only calls, never sources"
fi
printf 'source "$SOMEWHERE/lib/inno-spanned-server.sh"\n' > "$_wiring_probe"
if grep -Eq "$wiring_re" "$_wiring_probe"; then
  ok "CONTROL: wiring guard accepts any directory variable, not one spelling"
else
  bad "CONTROL: wiring guard rejected a correctly-sourced helper"
fi
rm -f "$_wiring_probe"

# 0b) target roots may be symlinks. Resolve the root before any manual
# artifact scan and follow links explicitly; a bare find over the link returns
# no rows with exit 0 on the affected host, which is indistinguishable from a
# genuine empty tree.
REAL_TARGET="$WORK/target-real"
LINK_TARGET="$WORK/target-link"
mkdir -p "$REAL_TARGET/release/bundle/appimage"
SYMLINK_APPIMAGE="$REAL_TARGET/release/bundle/appimage/Papercusp_${VER}_amd64.AppImage"
: > "$SYMLINK_APPIMAGE"
ln -s "$REAL_TARGET" "$LINK_TARGET"
EXPECTED_ROOT="$(cd "$REAL_TARGET" && pwd -P)"
RESOLVED_ROOT="$(release_artifacts_resolve_root "$LINK_TARGET")"
if [[ "$RESOLVED_ROOT" == "$EXPECTED_ROOT" ]]; then
  ok "resolves a symlinked target root to its physical directory"
else
  bad "symlinked target root resolved to '$RESOLVED_ROOT' (expected '$EXPECTED_ROOT')"
fi
mapfile -t FOLLOWED_APPIMAGES < <(find -L "$LINK_TARGET" -type f -name '*.AppImage' -print)
FOUND_APPIMAGE=""
if [[ "${#FOLLOWED_APPIMAGES[@]}" -eq 1 ]]; then
  FOUND_APPIMAGE="$(cd "$(dirname "${FOLLOWED_APPIMAGES[0]}")" && pwd -P)/$(basename "${FOLLOWED_APPIMAGES[0]}")"
fi
EXPECTED_APPIMAGE="$(cd "$(dirname "$SYMLINK_APPIMAGE")" && pwd -P)/$(basename "$SYMLINK_APPIMAGE")"
if [[ "$FOUND_APPIMAGE" == "$EXPECTED_APPIMAGE" ]]; then
  ok "symlink-safe artifact scan follows the target root"
else
  bad "symlink-safe artifact scan missed the AppImage under the target root"
fi

# 0c) build-linux-local.sh collects successful output into the source-tree
# target even when Cargo itself writes under a global target-dir.  The
# incremental publisher must look at that post-collection destination first or
# it reports a successful build as absent (EI-20320547917563727).
DESKTOP_ROOT="$WORK/desktop"
CARGO_ROOT="$WORK/cargo-target"
COLLECTED_BUNDLE="$DESKTOP_ROOT/src-tauri/target/release/bundle"
mkdir -p "$COLLECTED_BUNDLE/appimage" "$CARGO_ROOT/release/bundle"
COLLECTED_APPIMAGE="$COLLECTED_BUNDLE/appimage/Papercusp_${VER}_amd64.AppImage"
: > "$COLLECTED_APPIMAGE"
SELECTED_LINUX_ROOT="$(release_artifacts_linux_bundle_root "$DESKTOP_ROOT" "$CARGO_ROOT" "$VER")"
if [[ "$SELECTED_LINUX_ROOT" == "$COLLECTED_BUNDLE" ]]; then
  ok "Linux publish prefers the post-build source-tree collection destination"
else
  bad "Linux publish selected '$SELECTED_LINUX_ROOT' instead of collected '$COLLECTED_BUNDLE'"
fi
rm -f "$COLLECTED_APPIMAGE"
LEGACY_BUNDLE="$CARGO_ROOT/release/bundle"
: > "$LEGACY_BUNDLE/Papercusp_${VER}_amd64.AppImage"
SELECTED_LINUX_ROOT="$(release_artifacts_linux_bundle_root "$DESKTOP_ROOT" "$CARGO_ROOT" "$VER")"
if [[ "$SELECTED_LINUX_ROOT" == "$LEGACY_BUNDLE" ]]; then
  ok "Linux publish falls back to Cargo's target for an uncollected legacy build"
else
  bad "Linux publish did not retain the legacy Cargo-target fallback"
fi

# SIGNING SEAM (EI-20595279927716716). Normalization now SIGNS the zip it builds,
# so every case below that calls papercusp_normalize_spanned_server would otherwise
# reach for the host's real key and npx — network, seconds, and a different answer
# on a keyless box. Point it at a stub instead: this file stays hermetic and ~1s,
# and the cases that care about the unsigned path opt out explicitly.
STUB_SIGNER="$WORK/stub-signer"
cat > "$STUB_SIGNER" <<'STUB'
#!/usr/bin/env bash
# Stand-in for `tauri signer sign <file>`: same contract, no crypto.
[[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]] || exit 3   # refuse without a key, like the real one
# The real CLI rejects simultaneous content/path options, including env inputs.
[[ ! ${TAURI_SIGNING_PRIVATE_KEY_PATH+x} ]] || exit 4
[[ "$TAURI_SIGNING_PRIVATE_KEY" == "${PAPERCUSP_EXPECT_SIGNING_KEY:-$TAURI_SIGNING_PRIVATE_KEY}" ]] || exit 5
printf 'stub-signature\n' > "$1.sig"
STUB
chmod +x "$STUB_SIGNER"
export PAPERCUSP_SIGNER_CMD="$STUB_SIGNER"
export TAURI_SIGNING_PRIVATE_KEY="dGVzdC1rZXktY29udGVudA=="

# 0) every Windows entry point shares the DiskSpan normalization decision. The
# raw stub + slices are replaced by one zip for artifact selection, while the
# original files remain available for provenance/debugging.
if papercusp_normalize_spanned_server "$INNO" "$VER"; then
  ZIP="${PAPERCUSP_SPANNED_SERVER_ZIP}"
  [[ -s "$ZIP" ]] && ok "normalizes a spanned Server into a non-empty zip" \
    || bad "normalization reported success without a non-empty zip"
  if python3 - "$ZIP" "$EXE" "$BIN1" "$BIN2" <<'PY'
import sys, zipfile
archive, *files = sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    names = set(z.namelist())
for path in files:
    assert path.rsplit('/', 1)[-1] in names, (path, sorted(names))
PY
  then
    ok "normalized zip contains the stub and every DiskSpan slice"
  else
    bad "normalized zip omitted a stub or DiskSpan slice"
  fi
  if papercusp_spanned_server_artifact "$EXE" \
     && papercusp_spanned_server_artifact "$SIG" \
     && papercusp_spanned_server_artifact "$BIN1" \
     && papercusp_spanned_server_artifact "$ZIP"; then
    ok "shared matcher identifies raw span inputs and normalized zip"
  else
    bad "shared matcher missed a raw span input or normalized zip"
  fi
else
  bad "spanned Server normalization failed unexpectedly"
fi

NO_SPAN="$WORK/no-span"
mkdir -p "$NO_SPAN"
: > "$NO_SPAN/Papercusp Server_${VER}_x64-setup.exe"
if papercusp_normalize_spanned_server "$NO_SPAN" "$VER"; then
  bad "single-file Server was incorrectly classified as spanned"
else
  ok "single-file Server is not classified as spanned"
fi

# 0d) release callers must all use the shared retention/guard seam. A helper
# unit alone is not enough: a raw cleanup added back to one producer would
# silently reopen the disappearing-artifact class.
declare -A wiring_need=(
  [build-linux-local.sh]='papercusp_retain_release_paths'
  [build-appimage.sh]='release_artifacts_guarded_delete'
  [build-windows-cross.sh]='papercusp_retain_release_paths'
  [publish-platform-incremental.sh]='papercusp_retain_release_paths'
  [release-local.sh]='release_artifacts_guarded_delete'
)
for script in "${!wiring_need[@]}"; do
  if grep -Fq "${wiring_need[$script]}" "$DIR/../$script"; then
    ok "$script uses the shared release-retention seam"
  else
    bad "$script bypasses the shared release-retention seam"
  fi
done

# 1) write -> read round-trip carries the .bin slices AND the inno .exe/.sig.
release_artifacts_write "$TAG" "$EXE" "$SIG" "$BIN1" "$BIN2" "$DEB" >/dev/null
mapfile -t GOT < <(release_artifacts_read "$TAG")
have_in_got() { local needle="$1" g; for g in "${GOT[@]}"; do [[ "$g" == "$needle" ]] && return 0; done; return 1; }
[[ ${#GOT[@]} -eq 5 ]] && ok "read returns all 5 artifacts" || bad "read returned ${#GOT[@]} artifacts, expected 5"
have_in_got "$BIN1" && ok "carries Server .bin slice 1 (gap 2)"        || bad ".bin slice 1 was dropped (gap 2 regression)"
have_in_got "$BIN2" && ok "carries Server .bin slice 2 (gap 2)"        || bad ".bin slice 2 was dropped (gap 2 regression)"
have_in_got "$EXE"  && ok "carries the inno -setup.exe (gap 1)"        || bad "inno .exe missing (gap 1 regression)"
have_in_got "$SIG"  && ok "carries the inno .sig"                      || bad "inno .sig missing"

# The lease handoff must preserve each path independently. Passing the whole
# manifest through one command substitution collapses all five paths into one
# malformed marker, especially when names contain spaces.
LEASE="$(release_artifacts_retention_lease_path "$TAG")"
mapfile -t LEASE_PATHS < <(release_artifacts_retention_lease_read_paths "$LEASE")
if [[ ${#LEASE_PATHS[@]} -eq 5 ]]; then
  ok "retention lease records each manifest path independently"
else
  bad "retention lease recorded ${#LEASE_PATHS[@]} paths, expected 5"
fi
for expected in "$EXE" "$SIG" "$BIN1" "$BIN2" "$DEB"; do
  expected="$(release_artifacts_normalize_path "$expected")"
  have_lease_path=0
  for leased in "${LEASE_PATHS[@]}"; do
    [[ "$leased" == "$expected" ]] && have_lease_path=1 && break
  done
  [[ "$have_lease_path" -eq 1 ]] \
    && ok "lease retains $(basename "$expected") as an independent path" \
    || bad "lease omitted independent path $(basename "$expected")"
done

# 1b) guarded deletion denies an actively leased root, allows an unleased path,
# and audits both decisions with the deleter identity.
PROTECTED="$WORK/protected-target"; FREE="$WORK/free-target"
mkdir -p "$PROTECTED"; : > "$PROTECTED/final.deb"; : > "$FREE"
release_artifacts_retention_lease_acquire "$TAG_GUARD" "$PROTECTED" >/dev/null
if release_artifacts_guarded_delete "$PROTECTED" >/dev/null 2>&1; then
  bad "guarded deletion allowed an actively leased target root"
else
  ok "guarded deletion denies an actively leased target root"
fi
[[ -d "$PROTECTED" ]] && ok "denied target root remains intact" || bad "denied target root was removed"
if grep -Fq "decision=deny" "$PAPERCUSP_RELEASE_DELETION_AUDIT_PATH"; then
  ok "denied deletion is audited"
else
  bad "denied deletion was not audited"
fi
if release_artifacts_guarded_delete "$FREE" >/dev/null 2>&1; then
  ok "guarded deletion allows an unleased path"
else
  bad "guarded deletion rejected an unleased path"
fi
[[ ! -e "$FREE" ]] && ok "allowed target path is removed" || bad "allowed target path remains"
if grep -Fq "decision=allow" "$PAPERCUSP_RELEASE_DELETION_AUDIT_PATH"; then
  ok "allowed deletion is audited"
else
  bad "allowed deletion was not audited"
fi
# 1c) A cut must not be refused its OWN lease (EI-23946118243608426). The legs of one cut run
# CONCURRENTLY against a shared target slot: the windows leg finished first, took a lease over
# that slot, and the still-running linux sibling was then denied the stale-AppDir purge that
# WI-4736 REQUIRES it to perform — killing the leg ~90min in. The guard exists to stop one cut
# destroying ANOTHER cut's artifacts, so all three tag states are pinned here: own tag allows,
# foreign tag denies, absent tag fails closed.
OWNED="$WORK/own-lease-target"; FOREIGN="$WORK/foreign-lease-target"
mkdir -p "$OWNED" "$FOREIGN"; : > "$OWNED/stale.AppDir"; : > "$FOREIGN/other.AppDir"
release_artifacts_retention_lease_acquire "$TAG_GUARD" "$OWNED" "$FOREIGN" >/dev/null

if (unset PAPERCUSP_RELEASE_TAG; release_artifacts_guarded_delete "$OWNED" >/dev/null 2>&1); then
  bad "guarded deletion allowed a leased path with no cut tag in scope"
else
  ok "guarded deletion still fails closed when no cut tag is set"
fi

if (export PAPERCUSP_RELEASE_TAG="$TAG_GUARD"; release_artifacts_guarded_delete "$OWNED" >/dev/null 2>&1); then
  ok "guarded deletion allows a path leased by this cut's OWN tag"
else
  bad "guarded deletion refused this cut its own leased path (EI-23946118243608426)"
fi
[[ ! -e "$OWNED" ]] && ok "own-leased path is actually removed" || bad "own-leased path survived an allowed delete"

if (export PAPERCUSP_RELEASE_TAG="desktop-v0.0.0-some-other-cut"; release_artifacts_guarded_delete "$FOREIGN" >/dev/null 2>&1); then
  bad "guarded deletion allowed a path leased by ANOTHER cut's tag"
else
  ok "guarded deletion still denies a path leased by another cut"
fi
[[ -d "$FOREIGN" ]] && ok "foreign-leased path remains intact" || bad "foreign-leased path was removed"

release_artifacts_retention_lease_release "$TAG_GUARD" >/dev/null

# 2) read drops a vanished file and de-duplicates a repeated path.
release_artifacts_write "$TAG" "$EXE" "$EXE" "$SIG" "$BIN1" "$BIN2" "$DEB" >/dev/null  # $EXE twice
rm -f "$BIN2"
mapfile -t GOT2 < <(release_artifacts_read "$TAG")
[[ ${#GOT2[@]} -eq 4 ]] && ok "read skips a vanished file and de-dups (4 remain)" \
  || bad "read returned ${#GOT2[@]} after removing 1 + dup, expected 4"
# restore for the guard tests
: > "$BIN2"
release_artifacts_write "$TAG" "$EXE" "$SIG" "$BIN1" "$BIN2" "$DEB" >/dev/null

# 3) read FAILS HARD when there is no manifest — never a silent glob fallback.
if release_artifacts_read "$TAG_EMPTY" >/dev/null 2>&1; then
  bad "read of an unknown tag should fail, but succeeded (silent-fallback risk)"
else
  ok "read of an unknown tag returns non-zero (no drifting fallback)"
fi

# 4) recurrence guard PASSES when latest.json only advertises covered artifacts.
# URLs are percent-encoded exactly as release-local.sh emits them (spaces -> %20).
LATEST="$WORK/latest.json"
cat > "$LATEST" <<JSON
{ "version": "$VER", "platforms": {
    "windows-x86_64": { "signature": "x", "url": "https://h/secret/tag/Papercusp%20Server_${VER}_x64-setup.exe" },
    "linux-x86_64":   { "signature": "x", "url": "https://h/secret/tag/Papercusp_${VER}_amd64.deb" } } }
JSON
if release_artifacts_assert_urls_covered "$TAG" "$LATEST" 2>/dev/null; then
  ok "guard passes when every advertised url is in the upload set"
else
  bad "guard failed on a fully-covered manifest"
fi

# 5) recurrence guard FAILS when latest.json advertises an artifact NOT in the set.
# Strict mode (no reachability leg) so this stays hermetic and offline-safe.
LATEST_BAD="$WORK/latest-bad.json"
cat > "$LATEST_BAD" <<JSON
{ "version": "$VER", "platforms": {
    "windows-x86_64": { "signature": "x", "url": "https://h/secret/tag/Papercusp%20GUI_${VER}_x64-setup.exe" } } }
JSON
if RELEASE_ARTIFACTS_NO_REACHABILITY=1 \
   release_artifacts_assert_urls_covered "$TAG" "$LATEST_BAD" 2>/dev/null; then
  bad "guard passed a manifest advertising a NON-present artifact (LABELED!=PACKED not caught)"
else
  ok "guard catches an advertised-but-missing artifact before upload"
fi

# 5b) EI-20551860898590077 — same-version stale bytes are rejected per artifact,
# while a fresh control passes. The helper uses nanosecond mtimes, so a future
# cut cannot accidentally share a timestamp second with its predecessor.
FRESH="$WORK/fresh-artifact"
STALE="$WORK/stale-artifact"
: > "$STALE"
STAMP_NOW="$(release_artifacts_cut_start_now_ns)"
release_artifacts_cut_start_write "$TAG_FRESH" "$STAMP_NOW" >/dev/null
if release_artifacts_assert_fresh "$TAG_FRESH" "$STALE" 2>/dev/null; then
  bad "freshness guard accepted an artifact whose mtime predates the cut start"
else
  ok "freshness guard rejects a stale same-version artifact"
fi
sleep 0.01
: > "$FRESH"
if release_artifacts_assert_fresh "$TAG_FRESH" "$FRESH" 2>/dev/null; then
  ok "freshness guard accepts an artifact written after the cut start"
else
  bad "freshness guard rejected a fresh artifact"
fi
rm -f "$(release_artifacts_cut_start_path "$TAG_FRESH")"
if release_artifacts_assert_fresh "$TAG_FRESH" "$FRESH" >/dev/null 2>&1; then
  bad "freshness guard passed with a missing cut-start stamp"
else
  ok "freshness guard fails closed when the cut-start stamp is missing"
fi

# ── EI-20287537474245593: publish requires a byte-bound platform smoke ──────
SMOKE_DIR="$WORK/smoke-cut"; mkdir -p "$SMOKE_DIR"
SMOKE_GUI="$SMOKE_DIR/Papercusp GUI_${VER}_amd64.deb"
SMOKE_SERVER="$SMOKE_DIR/Papercusp Server_${VER}_amd64.deb"
printf 'gui-payload\n' > "$SMOKE_GUI"
printf 'server-payload\n' > "$SMOKE_SERVER"
SMOKE_PROV="$SMOKE_DIR/build-provenance.json"
SMOKE_BUILD_SHA="selftest-build-sha"
python3 - "$SMOKE_PROV" "$VER" "$SMOKE_BUILD_SHA" "$SMOKE_GUI" "$SMOKE_SERVER" <<'PY'
import hashlib, json, pathlib, sys
out, version, build_sha, *files = sys.argv[1:]
rows = []
for raw in files:
    path = pathlib.Path(raw)
    payload = path.read_bytes()
    rows.append({
        "name": path.name,
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    })
pathlib.Path(out).write_text(json.dumps({
    "version": version,
    "buildSha": build_sha,
    "artifacts": rows,
}) + "\n")
PY

if release_artifacts_smoke_receipt_write \
     "$TAG_SMOKE" "$VER" linux selftest-verifier "$SMOKE_BUILD_SHA" \
     "$SMOKE_PROV" "$SMOKE_GUI" "$SMOKE_SERVER" >/dev/null \
   && release_artifacts_assert_smoke_receipts \
     "$TAG_SMOKE" "$VER" "$SMOKE_GUI" "$SMOKE_SERVER" >/dev/null 2>&1; then
  ok "content-bound smoke receipt authorizes the exact GUI+Server platform bytes"
else
  bad "a valid content-bound GUI+Server smoke receipt was rejected"
fi
if [[ ! -e "$LATEST_WINDOWS_SMOKE" ]]; then
  ok "non-Windows smoke does not advance the Windows success watermark"
else
  bad "non-Windows smoke incorrectly advanced the Windows success watermark"
fi

# The publish-facing runner must actually invoke the canonical verifier when a
# receipt is absent, pass it the exact GUI+Server installers, and validate the
# receipt it writes before returning success. A stub exercises the real helper
# protocol without requiring a VM in this hermetic shell unit.
AUTO_VERIFIER="$WORK/automatic-platform-smoke-verifier.sh"
AUTO_LOG="$WORK/automatic-platform-smoke-verifier.log"
cat > "$AUTO_VERIFIER" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
platform=""; version=""; tag=""; gui=""; server=""; provenance=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) platform="${2:-}"; shift 2 ;;
    --expected-version) version="${2:-}"; shift 2 ;;
    --smoke-receipt-tag) tag="${2:-}"; shift 2 ;;
    --artifact) gui="${2:-}"; shift 2 ;;
    --server-artifact) server="${2:-}"; shift 2 ;;
    --smoke-provenance) provenance="${2:-}"; shift 2 ;;
    --json) shift ;;
    *) echo "unexpected automatic verifier arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$platform" && -n "$version" && -n "$tag" && -f "$gui" \
   && -f "$server" && -f "$provenance" ]]
printf '%s\n' "$platform" "$version" "$tag" "$gui" "$server" "$provenance" \
  > "$PAPERCUSP_AUTO_SMOKE_LOG"
build_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["buildSha"])' "$provenance")"
# shellcheck source=release-artifacts.sh
source "$PAPERCUSP_RELEASE_ARTIFACTS_HELPER"
release_artifacts_smoke_receipt_write \
  "$tag" "$version" "$platform" automatic-selftest "$build_sha" \
  "$provenance" "$gui" "$server" >/dev/null
STUB
chmod +x "$AUTO_VERIFIER"

AUTO_TAG="$TAG_SMOKE-automatic"
AUTO_OUTPUT="$(
  export PAPERCUSP_AUTO_SMOKE_LOG="$AUTO_LOG"
  export PAPERCUSP_RELEASE_ARTIFACTS_HELPER="$DIR/release-artifacts.sh"
  export PAPERCUSP_PLATFORM_SMOKE_VERIFIER="$AUTO_VERIFIER"
  release_artifacts_run_smoke_receipts \
    "$AUTO_TAG" "$VER" "$SMOKE_GUI" "$SMOKE_SERVER" 2>&1
)"
AUTO_RC=$?
mapfile -t AUTO_ARGS < "$AUTO_LOG" 2>/dev/null
if [[ "$AUTO_RC" -eq 0 \
      && "${AUTO_ARGS[0]:-}" == linux \
      && "${AUTO_ARGS[1]:-}" == "$VER" \
      && "${AUTO_ARGS[2]:-}" == "$AUTO_TAG" \
      && "${AUTO_ARGS[3]:-}" == "$SMOKE_GUI" \
      && "${AUTO_ARGS[4]:-}" == "$SMOKE_SERVER" \
      && "${AUTO_ARGS[5]:-}" == "$SMOKE_PROV" \
      && "$AUTO_OUTPUT" == *"smoke receipt verified"* ]]; then
  ok "automatic smoke runner invokes the canonical verifier with exact GUI+Server inputs"
else
  bad "automatic smoke runner did not complete the canonical verifier protocol (rc=$AUTO_RC output=$AUTO_OUTPUT)"
fi

# A current receipt is the durable result of an already-completed install. A
# re-publish must reuse it rather than relaunching a potentially destructive
# verifier. Pointing at a nonexistent verifier proves the helper returns before
# resolving or executing it.
AUTO_REUSE_OUTPUT="$(
  export PAPERCUSP_PLATFORM_SMOKE_VERIFIER="$WORK/verifier-must-not-run"
  release_artifacts_run_smoke_receipts \
    "$AUTO_TAG" "$VER" "$SMOKE_GUI" "$SMOKE_SERVER" 2>&1
)"
AUTO_REUSE_RC=$?
if [[ "$AUTO_REUSE_RC" -eq 0 && "$AUTO_REUSE_OUTPUT" == *"verifier run reused"* ]]; then
  ok "automatic smoke runner reuses a current content-bound receipt"
else
  bad "automatic smoke runner did not reuse the current receipt (rc=$AUTO_REUSE_RC output=$AUTO_REUSE_OUTPUT)"
fi

# Remote/macOS/Windows rigs use the custom-command seam. Its documented six
# positional arguments must carry real installer paths, not empty placeholders,
# and the helper must still validate the receipt the command produces.
AUTO_CUSTOM_VERIFIER="$WORK/custom-platform-smoke-verifier.sh"
AUTO_CUSTOM_LOG="$WORK/custom-platform-smoke-verifier.log"
cat > "$AUTO_CUSTOM_VERIFIER" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
platform="${1:-}"; version="${2:-}"; tag="${3:-}"
gui="${4:-}"; server="${5:-}"; provenance="${6:-}"
[[ -n "$platform" && -n "$version" && -n "$tag" && -f "$gui" \
   && -f "$server" && -f "$provenance" ]]
printf '%s\n' "$platform" "$version" "$tag" "$gui" "$server" "$provenance" \
  > "$PAPERCUSP_AUTO_SMOKE_LOG"
build_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["buildSha"])' "$provenance")"
# shellcheck source=release-artifacts.sh
source "$PAPERCUSP_RELEASE_ARTIFACTS_HELPER"
release_artifacts_smoke_receipt_write \
  "$tag" "$version" "$platform" custom-automatic-selftest "$build_sha" \
  "$provenance" "$gui" "$server" >/dev/null
STUB
chmod +x "$AUTO_CUSTOM_VERIFIER"
AUTO_CUSTOM_TAG="$TAG_SMOKE-custom"
AUTO_CUSTOM_OUTPUT="$(
  export PAPERCUSP_AUTO_SMOKE_LOG="$AUTO_CUSTOM_LOG"
  export PAPERCUSP_RELEASE_ARTIFACTS_HELPER="$DIR/release-artifacts.sh"
  export PAPERCUSP_AUTO_CUSTOM_VERIFIER="$AUTO_CUSTOM_VERIFIER"
  export PAPERCUSP_PLATFORM_SMOKE_CMD='exec "$PAPERCUSP_AUTO_CUSTOM_VERIFIER" "$@"'
  release_artifacts_run_smoke_receipts \
    "$AUTO_CUSTOM_TAG" "$VER" "$SMOKE_GUI" "$SMOKE_SERVER" 2>&1
)"
AUTO_CUSTOM_RC=$?
mapfile -t AUTO_CUSTOM_ARGS < "$AUTO_CUSTOM_LOG" 2>/dev/null
if [[ "$AUTO_CUSTOM_RC" -eq 0 \
      && "${AUTO_CUSTOM_ARGS[3]:-}" == "$SMOKE_GUI" \
      && "${AUTO_CUSTOM_ARGS[4]:-}" == "$SMOKE_SERVER" \
      && "${AUTO_CUSTOM_ARGS[5]:-}" == "$SMOKE_PROV" \
      && "$AUTO_CUSTOM_OUTPUT" == *"smoke receipt verified"* ]]; then
  ok "custom smoke runner receives exact installers and must produce a valid receipt"
else
  bad "custom smoke runner did not receive/validate its documented inputs (rc=$AUTO_CUSTOM_RC output=$AUTO_CUSTOM_OUTPUT)"
fi

# A verifier exit without a receipt is never a PASS, and a hard verifier failure
# must leave no newly-authorizing canonical or durable receipt behind.
AUTO_FAIL_VERIFIER="$WORK/failing-platform-smoke-verifier.sh"
printf '#!/usr/bin/env bash\nexit 23\n' > "$AUTO_FAIL_VERIFIER"
chmod +x "$AUTO_FAIL_VERIFIER"
AUTO_FAIL_TAG="$TAG_SMOKE-failing"
if (
  export PAPERCUSP_PLATFORM_SMOKE_VERIFIER="$AUTO_FAIL_VERIFIER"
  release_artifacts_run_smoke_receipts \
    "$AUTO_FAIL_TAG" "$VER" "$SMOKE_GUI" "$SMOKE_SERVER" >/dev/null 2>&1
); then
  bad "automatic smoke runner passed a failing verifier"
elif [[ -e "$(release_artifacts_smoke_receipt_path "$AUTO_FAIL_TAG" linux)" \
        || -e "$SMOKE_DIR/platform-smoke-${AUTO_FAIL_TAG}-linux.json" ]]; then
  bad "failing verifier left an authorizing smoke receipt behind"
else
  ok "automatic smoke runner fails closed and leaves no receipt after verifier failure"
fi

# Same names/version, changed Server bytes: the prior PASS must become stale.
printf 'mutated-after-smoke\n' >> "$SMOKE_SERVER"
if release_artifacts_assert_smoke_receipts \
     "$TAG_SMOKE" "$VER" "$SMOKE_GUI" "$SMOKE_SERVER" >/dev/null 2>&1; then
  bad "smoke gate accepted artifact bytes changed after the PASS"
else
  ok "smoke gate rejects a same-version artifact mutated after the PASS"
fi
printf 'server-payload\n' > "$SMOKE_SERVER"

# Receipt metadata must still agree with CURRENT provenance. Re-labeling the
# same bytes with a different build identity invalidates the prior PASS.
python3 - "$SMOKE_PROV" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text())
data["buildSha"] = "relabeled-after-smoke"
path.write_text(json.dumps(data) + "\n")
PY
if release_artifacts_assert_smoke_receipts \
     "$TAG_SMOKE" "$VER" "$SMOKE_GUI" "$SMOKE_SERVER" >/dev/null 2>&1; then
  bad "smoke gate accepted a receipt whose build identity no longer matches provenance"
else
  ok "smoke gate rejects a receipt after provenance build identity is relabeled"
fi
python3 - "$SMOKE_PROV" "$SMOKE_BUILD_SHA" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text())
data["buildSha"] = sys.argv[2]
path.write_text(json.dumps(data) + "\n")
PY

# A receipt may bind sibling provenance bytes without pretending it exercised
# them. Publication must still require an actually-exercised artifact per
# product, so a GUI-only run cannot authorize the split Server payload.
release_artifacts_smoke_receipt_write \
  "$TAG_SMOKE" "$VER" linux selftest-verifier "$SMOKE_BUILD_SHA" \
  "$SMOKE_PROV" "$SMOKE_GUI" >/dev/null
if release_artifacts_assert_smoke_receipts \
     "$TAG_SMOKE" "$VER" "$SMOKE_GUI" "$SMOKE_SERVER" >/dev/null 2>&1; then
  bad "GUI-only smoke receipt authorized an unexercised Server payload"
else
  ok "GUI-only smoke receipt cannot authorize a split Server payload"
fi

# Missing receipts fail closed. The hardware escape needs BOTH the exact flag
# and an auditable reason; a bare skip flag is still a refusal.
if release_artifacts_assert_smoke_receipts \
     "$TAG_SMOKE-missing" "$VER" "$SMOKE_GUI" >/dev/null 2>&1; then
  bad "publish smoke guard passed with no receipt"
else
  ok "publish smoke guard fails closed when the receipt is absent"
fi
if PAPERCUSP_SKIP_PLATFORM_SMOKE=1 \
   release_artifacts_assert_smoke_receipts \
     "$TAG_SMOKE-missing" "$VER" "$SMOKE_GUI" >/dev/null 2>&1; then
  bad "bare platform-smoke skip flag bypassed without a reason"
else
  ok "platform-smoke override refuses a missing reason"
fi
if PAPERCUSP_SKIP_PLATFORM_SMOKE=1 \
   PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON='self-test: no hardware' \
   release_artifacts_assert_smoke_receipts \
     "$TAG_SMOKE-missing" "$VER" "$SMOKE_GUI" >/dev/null 2>&1; then
  ok "reasoned platform-smoke hardware override is explicit and usable"
else
  bad "reasoned platform-smoke hardware override was rejected"
fi

# The incremental publisher must report the outcome produced by the runner,
# rather than turning every successful return (including an override) into a
# verifier PASS.
if grep -Fq 'release_artifacts_smoke_outcome_message "$PLATFORM" "$RELEASE_ARTIFACTS_SMOKE_OUTCOME"' \
     "$DIR/../publish-platform-incremental.sh"; then
  ok "incremental publisher reports the shared platform-smoke outcome"
else
  bad "incremental publisher bypasses the shared platform-smoke outcome"
fi
OVERRIDE_REPORT_OUTPUT="$(
  export PAPERCUSP_SKIP_PLATFORM_SMOKE=1
  export PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON='self-test: no hardware'
  if release_artifacts_run_smoke_receipts \
       "$TAG_SMOKE-override" "$VER" "$SMOKE_GUI" "$SMOKE_SERVER"; then
    release_artifacts_smoke_outcome_message windows "$RELEASE_ARTIFACTS_SMOKE_OUTCOME"
  fi
  2>&1
)"
OVERRIDE_REPORT_RC=$?
if [[ "$OVERRIDE_REPORT_RC" -eq 0 \
      && "$OVERRIDE_REPORT_OUTPUT" == *"OVERRIDDEN (no verification)"* \
      && "$OVERRIDE_REPORT_OUTPUT" != *"verifier passed"* ]]; then
  ok "override run reports no verification and never claims the verifier passed"
else
  bad "override run produced a false PASS or no override status (rc=$OVERRIDE_REPORT_RC output=$OVERRIDE_REPORT_OUTPUT)"
fi

# The Windows Server artifact published to users is a zip assembled AFTER the
# VM exercises its Inno stub+slices. Its container bytes need not pre-exist in
# the receipt, but every archive member must match an exercised, provenance-
# bound payload byte-for-byte.
SMOKE_WIN="$WORK/smoke-win"; mkdir -p "$SMOKE_WIN"
WIN_GUI="$SMOKE_WIN/Papercusp GUI_${VER}_x64-setup.exe"
WIN_STUB="$SMOKE_WIN/Papercusp Server_${VER}_x64-setup.exe"
WIN_SLICE="$SMOKE_WIN/Papercusp Server_${VER}_x64-setup-1.bin"
WIN_ZIP="$SMOKE_WIN/Papercusp Server_${VER}_x64-setup.zip"
printf 'win-gui\n' > "$WIN_GUI"
printf 'win-server-stub\n' > "$WIN_STUB"
printf 'win-server-slice\n' > "$WIN_SLICE"
WIN_PROV="$SMOKE_WIN/build-provenance.json"
python3 - "$WIN_PROV" "$WIN_ZIP" "$VER" "$SMOKE_BUILD_SHA" \
  "$WIN_GUI" "$WIN_STUB" "$WIN_SLICE" <<'PY'
import hashlib, json, pathlib, sys, zipfile
out, archive, version, build_sha, *files = sys.argv[1:]
rows = []
for raw in files:
    path = pathlib.Path(raw)
    payload = path.read_bytes()
    rows.append({"name": path.name, "bytes": len(payload),
                 "sha256": hashlib.sha256(payload).hexdigest()})
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as handle:
    for raw in files[1:]:
        handle.write(raw, pathlib.Path(raw).name)
pathlib.Path(out).write_text(json.dumps({"version": version,
    "buildSha": build_sha, "artifacts": rows}) + "\n")
PY
if release_artifacts_smoke_receipt_write \
     "$TAG_SMOKE-win" "$VER" windows selftest-verifier "$SMOKE_BUILD_SHA" \
     "$WIN_PROV" "$WIN_GUI" "$WIN_STUB" "$WIN_SLICE" >/dev/null \
   && release_artifacts_assert_smoke_receipts \
     "$TAG_SMOKE-win" "$VER" "$WIN_GUI" "$WIN_ZIP" >/dev/null 2>&1; then
  ok "Windows normalized zip is authorized only by its exact exercised stub+slices"
else
  bad "Windows normalized zip did not validate against its exercised payload members"
fi
if python3 - "$LATEST_WINDOWS_SMOKE" "$TAG_SMOKE-win" "$SMOKE_BUILD_SHA" <<'PY'
import json, pathlib, sys
marker = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert marker["schemaVersion"] == "papercusp-windows-smoke-success/v1"
assert marker["result"] == "pass" and marker["platform"] == "windows"
assert marker["tag"] == sys.argv[2] and marker["buildSha"] == sys.argv[3]
assert marker["verifiedAtUtc"].endswith("Z")
PY
then
  ok "validated Windows smoke advances the durable success watermark"
else
  bad "validated Windows smoke did not write a valid durable success watermark"
fi
mapfile -t WIN_SMOKE_INPUTS < <(
  release_artifacts_smoke_inputs windows "$WIN_GUI" "$WIN_ZIP"
)
if [[ "${WIN_SMOKE_INPUTS[0]:-}" == "$WIN_GUI" \
      && "${WIN_SMOKE_INPUTS[1]:-}" == "$WIN_STUB" ]]; then
  ok "automatic Windows smoke resolves the normalized Server zip back to its installable stub"
else
  bad "automatic Windows smoke selected the wrong GUI/Server inputs"
fi

# ── reachability leg (incremental publish) ───────────────────────────────────
# An artifact absent from THIS upload set but already live on the release host is
# covered: that is exactly what publish-platform-incremental.sh produces when it
# merges the live latest.json to add one platform. Judging those by local
# presence alone made the guard structurally unpassable on that path.
# The prober is injected so these cases are hermetic — no network, no live host.
PROBE_UP="$WORK/probe-up.sh";   printf '#!/bin/sh\nexit 0\n' > "$PROBE_UP";   chmod +x "$PROBE_UP"
PROBE_DOWN="$WORK/probe-down.sh"; printf '#!/bin/sh\nexit 1\n' > "$PROBE_DOWN"; chmod +x "$PROBE_DOWN"

# 6) an advertised-but-unpacked artifact that IS live on the host passes.
if RELEASE_ARTIFACTS_REACHABILITY_CMD="$PROBE_UP" \
   release_artifacts_assert_urls_covered "$TAG" "$LATEST_BAD" 2>/dev/null; then
  ok "guard passes an out-of-set artifact that is already live (incremental publish)"
else
  bad "guard blocked an already-live artifact — incremental publish is unpassable"
fi

# 7) CONTROL — the reachability leg must not blanket-pass. Same manifest, same
# code path, prober reporting NOT reachable: the guard must still catch it.
if RELEASE_ARTIFACTS_REACHABILITY_CMD="$PROBE_DOWN" \
   release_artifacts_assert_urls_covered "$TAG" "$LATEST_BAD" 2>/dev/null; then
  bad "guard passed an UNREACHABLE out-of-set artifact — the 404 class is no longer caught"
else
  ok "guard still catches an out-of-set artifact that is NOT reachable (fails closed)"
fi

# 8) CONTROL — a probe that ERRORS (non-executable / missing) must fail closed,
# not be mistaken for success.
if RELEASE_ARTIFACTS_REACHABILITY_CMD="$WORK/no-such-probe" \
   release_artifacts_assert_urls_covered "$TAG" "$LATEST_BAD" 2>/dev/null; then
  bad "a broken reachability probe was treated as reachable (fails OPEN)"
else
  ok "a broken reachability probe fails closed"
fi

# 9) CONTROL — a fully-covered manifest still passes with the leg enabled, and
# must not depend on the probe at all (nothing to probe).
if RELEASE_ARTIFACTS_REACHABILITY_CMD="$PROBE_DOWN" \
   release_artifacts_assert_urls_covered "$TAG" "$LATEST" 2>/dev/null; then
  ok "a fully-covered manifest passes without consulting the prober"
else
  bad "a fully-covered manifest was rejected when the prober reports down"
fi

# ── EI-20595279927716716: every published download must carry its .sig ───────
# The bug: signing followed the UPDATER pipeline, not the PUBLISHED set. `tauri
# build` signs what it bundles, so the Server zip — which WE assemble after the
# bundler — shipped with no signature in 0.0.16 AND 0.0.17 while every updater
# input beside it was signed. Nothing failed; a download simply could not be
# verified. Both halves are covered here: sign at creation, refuse at publish.

# 10) normalization SIGNS the zip it creates and publishes it through OUTPUTS —
# the array callers append. Naming the zip directly is how two of three call
# sites would silently drop a newly-added output.
if papercusp_normalize_spanned_server "$INNO" "$VER"; then
  [[ -n "$PAPERCUSP_SPANNED_SERVER_ZIP_SIG" && -s "$PAPERCUSP_SPANNED_SERVER_ZIP_SIG" ]] \
    && ok "normalization signs the zip it builds" \
    || bad "normalization produced no signature for the zip"
  if [[ ${#PAPERCUSP_SPANNED_SERVER_OUTPUTS[@]} -eq 2 \
        && "${PAPERCUSP_SPANNED_SERVER_OUTPUTS[0]}" == "$PAPERCUSP_SPANNED_SERVER_ZIP" \
        && "${PAPERCUSP_SPANNED_SERVER_OUTPUTS[1]}" == "$PAPERCUSP_SPANNED_SERVER_ZIP_SIG" ]]; then
    ok "OUTPUTS carries zip + signature in caller-append order"
  else
    bad "OUTPUTS did not carry zip+sig (${#PAPERCUSP_SPANNED_SERVER_OUTPUTS[@]} entries)"
  fi
  papercusp_spanned_server_artifact "$PAPERCUSP_SPANNED_SERVER_ZIP.sig" \
    && ok "shared matcher recognizes the zip signature (a re-scan cannot duplicate it)" \
    || bad "shared matcher missed the zip signature — a re-scan would double-add it"
else
  bad "spanned Server normalization failed unexpectedly under the signing seam"
fi

# EI-22617425259884298: resolving a path to content must also remove the inherited
# path option from the child. Otherwise a fully provisioned release fails BEFORE
# the signer reads the key. Keep caller env and the existing content-first
# precedence intact; all cases use synthetic keys and the real helper.
SIGNER_KEY_FILE="$WORK/signing key"
printf '%s\n' "$TAURI_SIGNING_PRIVATE_KEY" > "$SIGNER_KEY_FILE"
for key_mode in content path content-as-path; do
  if (
    export PAPERCUSP_EXPECT_SIGNING_KEY="$TAURI_SIGNING_PRIVATE_KEY"
    case "$key_mode" in
      content) export TAURI_SIGNING_PRIVATE_KEY_PATH="$WORK/unused-key" ;;
      path)
        unset TAURI_SIGNING_PRIVATE_KEY
        export TAURI_SIGNING_PRIVATE_KEY_PATH="$SIGNER_KEY_FILE"
        ;;
      content-as-path)
        export TAURI_SIGNING_PRIVATE_KEY="$SIGNER_KEY_FILE"
        export TAURI_SIGNING_PRIVATE_KEY_PATH="$WORK/unused-key"
        ;;
    esac
    original_key_path="$TAURI_SIGNING_PRIVATE_KEY_PATH"
    papercusp_sign_spanned_server_zip "$ZIP" \
      && [[ -s "$ZIP.sig" && "$TAURI_SIGNING_PRIVATE_KEY_PATH" == "$original_key_path" ]]
  ); then
    ok "signer isolates inherited key path ($key_mode) without changing caller env"
  else
    bad "signer leaked or changed inherited key path ($key_mode)"
  fi
done

# 11) A KEYLESS build still yields a usable zip. Signing is best-effort at BUILD
# time; refusing to SHIP an unsigned download is the publish guard's job. Getting
# this backwards would break every local/dev cut on a box with no signing key.
if ( unset PAPERCUSP_SIGNER_CMD TAURI_SIGNING_PRIVATE_KEY
     export TAURI_SIGNING_PRIVATE_KEY_PATH="$WORK/no-such-key"
     papercusp_normalize_spanned_server "$INNO" "$VER" 2>/dev/null \
       && [[ -s "$PAPERCUSP_SPANNED_SERVER_ZIP" \
             && -z "$PAPERCUSP_SPANNED_SERVER_ZIP_SIG" \
             && ${#PAPERCUSP_SPANNED_SERVER_OUTPUTS[@]} -eq 1 ]] ); then
  ok "a keyless build still yields a valid zip, unsigned, OUTPUTS holding only it"
else
  bad "keyless normalization did not degrade gracefully to an unsigned zip"
fi

TAG_SIG="$TAG-signatures"
SIGDIR="$WORK/sigcut"; mkdir -p "$SIGDIR"
mk_sig_artifact() { : > "$SIGDIR/$1"; printf '%s\n' "$SIGDIR/$1"; }
S_DEB="$(mk_sig_artifact "Papercusp GUI_${VER}_amd64.deb")"
S_DEB_SIG="$(mk_sig_artifact "Papercusp GUI_${VER}_amd64.deb.sig")"
S_EXE="$(mk_sig_artifact "Papercusp GUI_${VER}_x64-setup.exe")"
S_EXE_SIG="$(mk_sig_artifact "Papercusp GUI_${VER}_x64-setup.exe.sig")"
S_ZIP="$(mk_sig_artifact "Papercusp Server_${VER}_x64-setup.zip")"
S_ZIP_SIG="$(mk_sig_artifact "Papercusp Server_${VER}_x64-setup.zip.sig")"
S_TGZ="$(mk_sig_artifact "Papercusp GUI.app.tar.gz")"
S_TGZ_SIG="$(mk_sig_artifact "Papercusp GUI.app.tar.gz.sig")"
S_DMG="$(mk_sig_artifact "Papercusp GUI_${VER}_universal-apple-darwin.dmg")"
S_DMG_SIG="$(mk_sig_artifact "Papercusp GUI_${VER}_universal-apple-darwin.dmg.sig")"

# 12) CONTROL — a fully-signed cut passes. Without this, case 13 cannot tell a
# working guard from one that rejects everything.
release_artifacts_write "$TAG_SIG" "$S_DEB" "$S_DEB_SIG" "$S_EXE" "$S_EXE_SIG" \
  "$S_ZIP" "$S_ZIP_SIG" "$S_TGZ" "$S_TGZ_SIG" "$S_DMG" "$S_DMG_SIG" >/dev/null
if release_artifacts_assert_signatures_present "$TAG_SIG" 2>/dev/null; then
  ok "signature guard passes a fully-signed cut"
else
  bad "signature guard rejected a fully-signed cut (false positive)"
fi

# 13) FALSIFIABILITY — the guard must FAIL the exact shape that actually shipped:
# Server zip present, its .sig absent, everything else signed. A guard that
# cannot fail here would have waved 0.0.16 and 0.0.17 through unchanged.
release_artifacts_write "$TAG_SIG" "$S_DEB" "$S_DEB_SIG" "$S_EXE" "$S_EXE_SIG" \
  "$S_ZIP" "$S_TGZ" "$S_TGZ_SIG" "$S_DMG" "$S_DMG_SIG" >/dev/null
if release_artifacts_assert_signatures_present "$TAG_SIG" 2>/dev/null; then
  bad "signature guard PASSED an unsigned Server zip — the shape 0.0.16/0.0.17 shipped"
else
  ok "signature guard fails the unsigned-Server-zip shape that actually shipped"
fi

# 14) DMGs are published downloads, so an unsigned .dmg must fail exactly like
# every other signable artifact. This prevents the old exemption from returning.
release_artifacts_write "$TAG_SIG" "$S_DEB" "$S_DEB_SIG" "$S_EXE" "$S_EXE_SIG" \
  "$S_ZIP" "$S_ZIP_SIG" "$S_DMG" >/dev/null
DMG_ERR="$(release_artifacts_assert_signatures_present "$TAG_SIG" 2>&1 >/dev/null)"
DMG_RC=$?
[[ "$DMG_RC" -ne 0 ]] \
  && ok "signature guard fails an unsigned .dmg" \
  || bad "signature guard passed an unsigned .dmg (exemption returned)"
case "$DMG_ERR" in
  *"Papercusp GUI_${VER}_universal-apple-darwin.dmg"*) ok "the unsigned .dmg is named on stderr" ;;
  *)                                                   bad "the unsigned .dmg was not named on stderr" ;;
esac

# 15) The documented escape is honoured, so a deliberate keyless cut is never
# hard-blocked even when it contains an unsigned DMG.
release_artifacts_write "$TAG_SIG" "$S_ZIP" "$S_DMG" >/dev/null
if RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK=1 \
   release_artifacts_assert_signatures_present "$TAG_SIG" 2>/dev/null; then
  ok "RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK=1 skips the check for keyless cuts"
else
  bad "the documented signature-check escape did not skip"
fi
rm -f "$(release_artifacts_manifest_path "$TAG_SIG")"

# ---------------------------------------------------------------------------
# COLLECTOR-side signature completeness (release_artifacts_assert_collected_sigs_complete).
# The guard above reads the RECORDED SET and therefore cannot distinguish "never
# signed" from "signed, but the collector's glob dropped it" — it reports both as
# "would publish an unsigned download". These cases cover the other half.
# ---------------------------------------------------------------------------

# 16) CONTROL — a collected set that includes every sibling .sig passes. Without
# this, case 17 cannot tell a working guard from one that rejects everything.
if release_artifacts_assert_collected_sigs_complete "control" \
     "$S_DEB" "$S_DEB_SIG" "$S_DMG" "$S_DMG_SIG" 2>/dev/null; then
  ok "collected-sig guard passes a set that collected every .sig"
else
  bad "collected-sig guard rejected a complete collected set (false positive)"
fi

# 17) FALSIFIABILITY — the guard must FAIL the exact shape that actually happened on
# 0.0.21-alpha: the .dmg collected, its .sig present ON DISK but absent from the set.
COLL_ERR="$(release_artifacts_assert_collected_sigs_complete "mac" \
              "$S_DEB" "$S_DEB_SIG" "$S_DMG" 2>&1 >/dev/null)"
COLL_RC=$?
[[ "$COLL_RC" -ne 0 ]] \
  && ok "collected-sig guard fails a dropped .dmg.sig that exists on disk" \
  || bad "collected-sig guard PASSED a dropped .dmg.sig — the 0.0.21-alpha shape"
# Naming the uncollected signature's PATH is the whole point: it is what redirects the
# reader from the signing pipeline (and from weakening the publish-time guard) to the glob.
case "$COLL_ERR" in
  *"$S_DMG_SIG"*) ok "the uncollected signature's path is named on stderr" ;;
  *)              bad "the uncollected signature's path was not named on stderr" ;;
esac

# 18) NON-OVERLAP — an artifact with NO .sig anywhere on disk is the OTHER guard's
# business (it is genuinely unsigned), so this one must stay silent. Without this case
# the two guards could be collapsed into one, which would re-bury the distinction that
# makes case 17's error message useful — and would make a keyless cut unpublishable.
S_UNSIGNED="$(mk_sig_artifact "Papercusp Keyless_${VER}_amd64.deb")"
if release_artifacts_assert_collected_sigs_complete "keyless" "$S_UNSIGNED" 2>/dev/null; then
  ok "collected-sig guard stays silent on a genuinely unsigned artifact (no .sig on disk)"
else
  bad "collected-sig guard fired on a genuinely unsigned artifact — it is duplicating the publish-time guard"
fi

# 19) The documented escape is honoured here too, so a keyless cut is never hard-blocked.
if RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK=1 \
   release_artifacts_assert_collected_sigs_complete "mac" "$S_DMG" 2>/dev/null; then
  ok "RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK=1 skips the collected-sig check too"
else
  bad "the documented signature-check escape did not skip the collected-sig check"
fi

echo
echo "own-cut retention lease (EI-23946118243608426)"
# A cut must never be refused its OWN lease. The lease is tag-scoped and spans the
# whole cut (it pre-registers the mac/windows paths), so leg N+1 carries the SAME
# tag as the lease leg N took — refusing on any match at all drove the mac leg to a
# private per-pid slot where PAPERCUSP_REUSE_LINUX found no linux artifacts and the
# leg died after ~35min of redone work. Every not-ours case must still fail CLOSED.
__pc_saved_tag="${PAPERCUSP_RELEASE_TAG:-}"

PAPERCUSP_RELEASE_TAG="desktop-v0.0.22-alpha"

if release_artifacts_retention_matches_are_own_cut "desktop-v0.0.22-alpha"; then
  ok "own tag is recognised as this cut's own lease"
else
  bad "own tag was refused — a cut is locked out of its own slot (the 35min bug)"
fi

# The real three-leg shape: one lease, several matching path lines, all same tag.
if release_artifacts_retention_matches_are_own_cut "$(printf 'desktop-v0.0.22-alpha\ndesktop-v0.0.22-alpha\n')"; then
  ok "several matches all bearing this cut's tag are still its own lease"
else
  bad "a multi-line all-own match was refused"
fi

if release_artifacts_retention_matches_are_own_cut "desktop-v0.0.21-alpha"; then
  bad "a FOREIGN cut's lease was treated as ours — cross-cut protection is broken"
else
  ok "a foreign cut's lease is still refused"
fi

if release_artifacts_retention_matches_are_own_cut "$(printf 'desktop-v0.0.22-alpha\ndesktop-v0.0.21-alpha\n')"; then
  bad "a mixed own+foreign match was allowed — it must fail closed on the foreign tag"
else
  ok "a mixed own+foreign match fails closed"
fi

if release_artifacts_retention_matches_are_own_cut "invalid:/tmp/lease-broken.tsv"; then
  bad "an unreadable retention marker was treated as our own lease"
else
  ok "an invalid: retention marker fails closed"
fi

if release_artifacts_retention_matches_are_own_cut ""; then
  bad "an empty match set was treated as our own lease"
else
  ok "an empty match set fails closed"
fi

unset PAPERCUSP_RELEASE_TAG
if release_artifacts_retention_matches_are_own_cut "desktop-v0.0.22-alpha"; then
  bad "an UNSET PAPERCUSP_RELEASE_TAG claimed someone else's lease as ours"
else
  ok "an unset release tag fails closed"
fi
if [[ -n "$__pc_saved_tag" ]]; then PAPERCUSP_RELEASE_TAG="$__pc_saved_tag"; fi

# The predicate above is only half the fix: the SLOT PICKER has to consult it. The
# original bug was claim-target-dir.sh discarding the tags the predicate prints
# (`>/dev/null`), which leaves it unable to tell its own cut from a foreign one.
# Subject is a DIFFERENT file than this test, so these greps cannot self-match.
# Subject path is overridable so falsifiability can be proven against a mutated COPY
# outside the tree — never by mutating the shared checkout, which the git-sync sweep
# can commit mid-probe.
__pc_picker="${PAPERCUSP_SELFTEST_PICKER:-$DIR/claim-target-dir.sh}"
if [[ -s "$__pc_picker" ]]; then
  ok "control: the slot picker is present and non-empty (these checks measured something)"

  # Match a STDOUT discard only. `2>/dev/null` merely silences stderr and is correct;
  # it is discarding stdout that throws away the tags, so the char before `>` must
  # not be a digit (which would make it an fd redirect like 2> or 1>).
  if grep -qE 'release_artifacts_retention_path_is_leased[^|&]*[^0-9]>/dev/null' "$__pc_picker"; then
    bad "the slot picker discards lease tags again (>/dev/null) — it cannot tell its OWN cut from a foreign one"
  else
    ok "the slot picker keeps the lease tags instead of discarding them"
  fi

  if grep -q 'release_artifacts_retention_matches_are_own_cut' "$__pc_picker"; then
    ok "the slot picker defers to the shared own-cut rule"
  else
    bad "the slot picker no longer consults release_artifacts_retention_matches_are_own_cut"
  fi
else
  bad "control FAILED: $__pc_picker missing or empty — the slot-picker checks measured nothing"
fi

# WI-10003533: the own-cut rule reads PAPERCUSP_RELEASE_TAG, so release-local.sh must
# SET the tag before it sources the slot picker. It used to export the tag ~1700 lines
# later, so on a real launch the rule saw an empty tag and every run-leg retry skipped
# its own leased slot (and the artifacts its earlier legs left there). Subject path is
# overridable so falsifiability can be proven against a mutated COPY outside the tree.
__pc_release_local="${PAPERCUSP_SELFTEST_RELEASE_LOCAL:-$DIR/../release-local.sh}"
__pc_claim_line="$(grep -nE '^[[:space:]]*source[[:space:]].*lib/claim-target-dir\.sh' "$__pc_release_local" 2>/dev/null | head -1 | cut -d: -f1)"
__pc_tag_line="$(grep -nE '^[[:space:]]*(export[[:space:]]+)?PAPERCUSP_RELEASE_TAG=' "$__pc_release_local" 2>/dev/null | head -1 | cut -d: -f1)"
if [[ -n "$__pc_claim_line" && -n "$__pc_tag_line" ]]; then
  ok "control: release-local.sh claims a slot (line $__pc_claim_line) and sets the release tag (line $__pc_tag_line)"
  if (( __pc_tag_line < __pc_claim_line )); then
    ok "release-local.sh sets PAPERCUSP_RELEASE_TAG before it claims a target slot"
  else
    bad "release-local.sh claims its target slot (line $__pc_claim_line) before setting PAPERCUSP_RELEASE_TAG (line $__pc_tag_line) — the own-cut lease exemption sees an empty tag"
  fi
else
  bad "control FAILED: could not locate the slot claim or the tag assignment in $__pc_release_local — this check measured nothing"
fi

echo
echo "retention lease TTL (WI-10002441)"
# A lease with expires_ns=0 is PERMANENT. The release workflow wrote nothing but
# expires_ns=0 for its whole life, so every cut pinned its target slot forever
# (lease-desktop-v0.0.19-alpha held dev2 from 2026-09-07). These prove the bounded
# path works AND that an elapsed lease actually frees the path again.
__pc_ttl_tag="desktop-v0.0.0-selftest-ttl-$$"
__pc_ttl_file="$WORK/ttl-subject.txt"
: > "$__pc_ttl_file"

( unset PAPERCUSP_RELEASE_RETENTION_TTL_SEC
  release_artifacts_retention_lease_acquire "$__pc_ttl_tag" "$__pc_ttl_file" ) >/dev/null
if grep -qx 'expires_ns=0' "$(release_artifacts_retention_lease_path "$__pc_ttl_tag")"; then
  ok "no TTL still yields a permanent lease (the documented default is unchanged)"
else
  bad "the library default changed — expires_ns should be 0 when no TTL is set"
fi

rm -f "$(release_artifacts_retention_lease_path "$__pc_ttl_tag")"
( export PAPERCUSP_RELEASE_RETENTION_TTL_SEC=3600
  release_artifacts_retention_lease_acquire "$__pc_ttl_tag" "$__pc_ttl_file" ) >/dev/null
if grep -qx 'expires_ns=0' "$(release_artifacts_retention_lease_path "$__pc_ttl_tag")"; then
  bad "a TTL of 3600 still wrote a PERMANENT lease (expires_ns=0)"
else
  ok "a TTL yields a bounded lease (expires_ns > 0)"
fi

# The payoff: an elapsed lease must stop pinning its path, or a TTL buys nothing.
__pc_ttl_expired="$(release_artifacts_retention_lease_path "${__pc_ttl_tag}-expired")"
{
  printf 'schema=papercusp-release-retention/v1\n'
  printf 'tag=%s-expired\n' "$__pc_ttl_tag"
  printf 'created_ns=1\n'
  printf 'expires_ns=2\n'
  printf 'path=%s\n' "$__pc_ttl_file"
} > "$__pc_ttl_expired"
rm -f "$(release_artifacts_retention_lease_path "$__pc_ttl_tag")"
if release_artifacts_retention_path_is_leased "$__pc_ttl_file" >/dev/null 2>&1; then
  bad "an EXPIRED lease still pins its path — a TTL would never free a target slot"
else
  ok "an expired lease no longer pins its path (the slot is reclaimable)"
fi
rm -f "$__pc_ttl_expired"

# DRIFT GUARD, derived not hand-listed: any entry point that exports
# PAPERCUSP_RELEASE_TAG causes a lease to be acquired, so it must also state a
# retention window. A new entry point that forgets re-introduces this bug silently.
__pc_bin_dir="${PAPERCUSP_SELFTEST_BIN_DIR:-$DIR/..}"
__pc_tag_setters=()
while IFS= read -r f; do
  [[ -n "$f" ]] && __pc_tag_setters+=("$f")
done < <(grep -rlE '^[[:space:]]*export[^#]*PAPERCUSP_RELEASE_TAG=' "$__pc_bin_dir" --include='*.sh' 2>/dev/null | sort)

if [[ "${#__pc_tag_setters[@]}" -ge 2 ]]; then
  ok "control: found ${#__pc_tag_setters[@]} release entry point(s) exporting PAPERCUSP_RELEASE_TAG (the scan sees something)"
  __pc_ttl_missing=()
  for f in "${__pc_tag_setters[@]}"; do
    grep -qE 'PAPERCUSP_RELEASE_RETENTION_TTL_SEC=' "$f" || __pc_ttl_missing+=("${f##*/}")
  done
  if [[ "${#__pc_ttl_missing[@]}" -eq 0 ]]; then
    ok "every release entry point that exports the tag also sets a retention TTL"
  else
    bad "entry point(s) export PAPERCUSP_RELEASE_TAG with NO retention TTL — their leases pin paths forever: ${__pc_ttl_missing[*]}"
  fi
else
  bad "control FAILED: the entry-point scan found ${#__pc_tag_setters[@]} tag setter(s) under $__pc_bin_dir — expected at least 2, so this check measured nothing"
fi

echo
if [[ "$FAILS" -eq 0 ]]; then
  echo "release-artifacts self-test: ALL PASS"
  exit 0
else
  echo "release-artifacts self-test: $FAILS FAILED"
  exit 1
fi
