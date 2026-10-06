#!/usr/bin/env bash
# publish-platform-incremental.sh — ADD one freshly-built platform's artifacts
# onto an ALREADY-PUBLISHED desktop release, without touching (or re-uploading,
# re-signing, or re-dating) any OTHER platform's entry.
#
# WHY THIS EXISTS (EI-18111560213741904): publishing mac 0.0.12 onto an already-
# published linux 0.0.12 had no first-class path — bin/release-local.sh ALWAYS
# rebuilds Linux fresh (no REUSE_LINUX salvage) and regenerates latest.json from
# scratch from THIS run's artifact set, so re-running it just to add mac would
# re-cut + re-upload linux with CHANGED bytes/sig. The owner directive (2026-07-
# 15) is to publish each platform "as soon as each gets ready", not wait for all
# three — this script is the first-class tool for exactly that: a platform that
# becomes ready LATER, merged onto what's already live.
#
# Usage:
#   bin/publish-platform-incremental.sh <version> <channel: alpha|beta|stable|nightly> <platform: linux|windows|mac>
#
# What it does:
#   1. Globs the platform's already-built artifacts from the SAME version-scoped
#      locations bin/release-local.sh collects from (this box is a single-host
#      cross-compile setup — mac/windows build NATIVELY here now, WI-5651 — so
#      every platform's leg output lands under $ROOT/src-tauri/target/... no
#      matter which script produced it: run bin/build-linux-local.sh /
#      bin/build-mac-cross.sh / bin/build-windows-cross.sh FIRST).
#   2. Fetches the CURRENTLY-PUBLISHED latest.json (+ latest-server.json, best-
#      effort) from the release host as the merge base — the genuinely LIVE
#      manifest, not a locally-cached guess. Unreachable/absent (first publish
#      of a new release) ⇒ starts fresh, same as a normal cut.
#   3. Merges via bin/lib/gen-latest-manifest.sh's MERGE MODE
#      (GEN_LATEST_MANIFEST_MERGE_*_JSON): this platform's entries overlay the
#      base; every OTHER platform key carries through byte-for-byte untouched —
#      never regenerated, never re-signed, never re-dated.
#   4. Extends this tag's recorded artifact-SET (bin/lib/release-artifacts.sh)
#      with the new files UNIONED onto whatever was already recorded — normally
#      the other, already-live platform's files, still on disk on this single-
#      host setup — so bin/upload-release.sh's recurrence guard sees every
#      advertised url covered, and its upload loop only pushes what's new.
#   5. Prints the result + the exact next command. It does NOT upload —
#      bin/upload-release.sh <version> <channel> remains the one publish step
#      (artifacts first, manifest last, self-verified public read path).
#
# Windows Server DiskSpans are normalized by the shared helper below before this
# script builds a manifest; raw stubs must never reach the upload set.
# Recipe + gotchas this formalizes (EI-18111560213741904): a tauri .sig is
# ALREADY base64 — never re-encode it (silent double-encode, breaks the
# updater); a VM→host leg (if one ever returns) needs careful quoting for
# filenames with spaces — not a concern on the current single-host setup.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib/gen-latest-manifest.sh
source "$HERE/lib/gen-latest-manifest.sh"
# shellcheck source=lib/release-artifacts.sh
source "$HERE/lib/release-artifacts.sh"
# shellcheck source=lib/cargo-target-root.sh
source "$HERE/lib/cargo-target-root.sh"
# WI-20118266632432430: use the same Server DiskSpan normalization as the full
# release cut and direct Windows cross-builder.
# shellcheck source=lib/inno-spanned-server.sh
source "$HERE/lib/inno-spanned-server.sh"
# shellcheck source=lib/release-host.sh
source "$HERE/lib/release-host.sh"

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <version> <channel: alpha|beta|stable|nightly> <platform: linux|windows|mac>" >&2
  exit 2
fi
VERSION="$1"
CHANNEL="$2"
PLATFORM="$3"
case "$PLATFORM" in
  linux|windows|mac) ;;
  *) echo "ERROR: platform must be linux|windows|mac (got '$PLATFORM')" >&2; exit 2 ;;
esac

TAG="$(desktop_release_tag "$VERSION" "$CHANNEL")"
echo "==> version=$VERSION channel=$CHANNEL platform=$PLATFORM tag=$TAG"

# EI-20551860898590077: retain the original full-cut start when this is an
# incremental addition; otherwise already-live platforms in the union would be
# incorrectly judged stale against a newly-created stamp. A first incremental
# publish with no prior cut creates the stamp and then checks only NEW_ARTIFACTS.
PAPERCUSP_RELEASE_CUT_START_NS="$(release_artifacts_cut_start_ensure "$TAG")"
export PAPERCUSP_RELEASE_CUT_START_NS PAPERCUSP_RELEASE_TAG="$TAG"
# Bound this publish's retention lease -- same contract and same reason as
# release-local.sh (WI-10002441). Any entry point that exports
# PAPERCUSP_RELEASE_TAG will cause a lease to be acquired, so it must also state a
# retention window or it writes expires_ns=0 and pins its paths forever. Kept in
# sync by the release-artifacts selftest, which fails if an entry point sets the
# tag without a TTL.
export PAPERCUSP_RELEASE_RETENTION_TTL_SEC="${PAPERCUSP_RELEASE_RETENTION_TTL_SEC:-604800}"
echo "==> release artifact freshness: cut-start=$PAPERCUSP_RELEASE_CUT_START_NS"

load_release_host
if [[ -z "${PAPERCUSP_UPDATE_BASE_URL:-}" ]]; then
  echo "ERROR: no release host configured (~/.papercusp/release-host.env) — cannot fetch the" >&2
  echo "       live manifest to merge onto, and cannot compute real download urls." >&2
  exit 1
fi

# ── [1] glob this platform's already-built artifacts (version-scoped, same
# globs bin/release-local.sh's collection step uses) ─────────────────────────
CARGO_TARGET_ROOT="$(papercusp_cargo_target_root "$ROOT/src-tauri")" || exit $?

NEW_ARTIFACTS=()
RETENTION_PATHS=()
case "$PLATFORM" in
  linux)
    # build-linux-local.sh moves finished bundles out of Cargo's (possibly
    # globally relocated) target into this source-tree collection directory.
    # Prefer that canonical post-build tree; keep Cargo's tree only as a legacy
    # fallback for direct/older builders that did not perform collection.
    BUNDLE="$(release_artifacts_linux_bundle_root "$ROOT" "$CARGO_TARGET_ROOT" "$VERSION")"
    RETENTION_PATHS=("$CARGO_TARGET_ROOT" "$BUNDLE")
    for f in "$BUNDLE"/deb/*_"$VERSION"_*.deb "$BUNDLE"/deb/*_"$VERSION"_*.deb.sig \
             "$BUNDLE"/appimage/*_"$VERSION"_*.AppImage "$BUNDLE"/appimage/*_"$VERSION"_*.AppImage.sig; do
      [[ -f "$f" ]] && NEW_ARTIFACTS+=("$f")
    done
    ;;
  windows)
    for f in "$ROOT"/src-tauri/target/windows-vm/bundle/inno/*_"$VERSION"_*; do
      [[ -f "$f" ]] && NEW_ARTIFACTS+=("$f")
    done
    # A direct cross-build leaves the raw DiskSpan files beside the generated
    # zip. Normalize here too, then replace the stub/slices in the artifact
    # array; otherwise this path advertises the payload-less stub while the
    # slices remain unpublished. A single-file Server (no slices) and the GUI
    # installer are valid and pass through unchanged.
    _win_inno_dir="$ROOT/src-tauri/target/windows-vm/bundle/inno"
    RETENTION_PATHS=("$ROOT/src-tauri/target/windows-vm" "$_win_inno_dir")
    if papercusp_normalize_spanned_server "$_win_inno_dir" "$VERSION"; then
      _win_kept=()
      for _a in "${NEW_ARTIFACTS[@]}"; do
        papercusp_spanned_server_artifact "$_a" && continue
        _win_kept+=("$_a")
      done
      # OUTPUTS, not the bare zip — it also carries the zip's updater signature
      # (EI-20595279927716716).
      NEW_ARTIFACTS=( "${_win_kept[@]}" "${PAPERCUSP_SPANNED_SERVER_OUTPUTS[@]}" )
      echo "==> normalized spanned Server → $(basename "$PAPERCUSP_SPANNED_SERVER_ZIP") (stub + ${#PAPERCUSP_SPANNED_SERVER_SLICES[@]} slice(s))"
    elif [[ -n "$PAPERCUSP_SPANNED_SERVER_STUB" && ${#PAPERCUSP_SPANNED_SERVER_SLICES[@]} -gt 0 ]]; then
      echo "ERROR: spanned Server installer detected but normalization failed — refusing to publish the raw stub+slices" >&2
      exit 1
    fi
    ;;
  mac)
    OUT="$ROOT/src-tauri/target/universal-apple-darwin/release/bundle"
    RETENTION_PATHS=("$ROOT/src-tauri/target/universal-apple-darwin" "$OUT")
    # The .dmg.sig glob is load-bearing, not decorative. DMGs became part of the
    # SIGNED published set under D-019 + WI-39600 (the producer now emits a minisign
    # sibling for every user-facing download), but this collector was never updated to
    # PICK UP those signatures — so an incremental mac publish recorded the .dmg while
    # silently leaving its .sig out of the artifact set. release_artifacts_assert_signatures_present
    # then correctly refused the whole merge ("would publish an unsigned download",
    # EI-20595279927716716), because the guard reads the RECORDED SET, not the filesystem:
    # the signature existed on disk the entire time and was simply never collected.
    # Measured on 0.0.21-alpha: both dmg sigs present on disk, neither in the 6 globbed paths.
    for f in "$OUT"/dmg/*_"$VERSION"_*.dmg "$OUT"/dmg/*_"$VERSION"_*.dmg.sig "$OUT"/macos/*.app.tar.gz "$OUT"/macos/*.app.tar.gz.sig; do
      [[ -f "$f" ]] && NEW_ARTIFACTS+=("$f")
    done
    ;;
esac
if [[ ${#NEW_ARTIFACTS[@]} -eq 0 ]]; then
  echo "ERROR: no $PLATFORM artifacts found for version $VERSION — build it first" >&2
  echo "       (bin/build-linux-local.sh / bin/build-mac-cross.sh / bin/build-windows-cross.sh)." >&2
  exit 1
fi
echo "==> found ${#NEW_ARTIFACTS[@]} $PLATFORM artifact(s):"
for f in "${NEW_ARTIFACTS[@]}"; do echo "      $(basename "$f")"; done

# Catch a dropped signature HERE, where the fault actually is, rather than three steps
# later as "would publish an unsigned download" about an artifact that is in fact signed
# (EI-23962107353168459 — the mac collector globbed *.dmg but not *.dmg.sig).
if ! release_artifacts_assert_collected_sigs_complete "$PLATFORM" "${NEW_ARTIFACTS[@]}"; then
  echo "ERROR: the $PLATFORM collector above did not pick up signature(s) that exist on disk — refusing to merge an incomplete set." >&2
  exit 1
fi

if ! release_artifacts_assert_fresh "$TAG" "${NEW_ARTIFACTS[@]}"; then
  echo "ERROR: one or more $PLATFORM artifacts predate this cut's freshness stamp — refusing to merge/publish stale same-version bytes (EI-20551860898590077)." >&2
  exit 1
fi

# EI-20287537474245593: "built" is not "smoke-verified". Require the
# canonical install-and-relaunch verifier's content-bound receipt BEFORE this
# platform can be merged into the live manifest. A same-version rebuild changes
# the hashes and invalidates the old receipt. Hardware-unavailable publication
# remains possible only through the shared, reason-required logged override.
if release_artifacts_run_smoke_receipts "$TAG" "$VERSION" "${NEW_ARTIFACTS[@]}"; then
  release_artifacts_smoke_outcome_message "$PLATFORM" "$RELEASE_ARTIFACTS_SMOKE_OUTCOME"
else
  echo "ERROR: $PLATFORM is built but its automatic installed-artifact smoke did not produce a valid receipt for these exact bytes — refusing to merge it into $TAG." >&2
  echo "       Configure PAPERCUSP_PLATFORM_SMOKE_CMD for a role-specific remote rig, or use" >&2
  echo "       PAPERCUSP_SKIP_PLATFORM_SMOKE=1 plus PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON only for a deliberate hardware exception." >&2
  exit 1
fi

# ── [2] fetch the LIVE manifest(s) as the merge base ─────────────────────────
MERGE_GUI="$(mktemp /tmp/papercusp-merge-base-gui-XXXXXX.json)"
MERGE_SRV="$(mktemp /tmp/papercusp-merge-base-server-XXXXXX.json)"
cleanup_merge_base() { rm -f "$MERGE_GUI" "$MERGE_SRV"; }
trap cleanup_merge_base EXIT

# fetch_live <url-suffix> <out-file> -> 0 (writes body to <out-file>) iff HTTP 200
fetch_live() {
  local suffix="$1" out="$2" code
  code="$(curl -sS -o "$out" -w '%{http_code}' --max-time 20 "${PAPERCUSP_UPDATE_BASE_URL}/${suffix}" 2>/dev/null)" || true
  [[ "$code" == "200" && -s "$out" ]]
}

if fetch_live "latest.json" "$MERGE_GUI"; then
  echo "==> fetched the LIVE latest.json as the merge base"
else
  : > "$MERGE_GUI"
  echo "==> no live latest.json reachable (first publish of this release, or host not yet bound) — starting fresh for GUI"
fi
if fetch_live "latest-server.json" "$MERGE_SRV"; then
  echo "==> fetched the LIVE latest-server.json as the merge base"
else
  : > "$MERGE_SRV"
  echo "==> no live latest-server.json reachable — starting fresh for Server"
fi

# ── [3] merge — this platform's entries overlay the base; every OTHER platform
# key carries through byte-for-byte untouched (gen_latest_manifest MERGE MODE,
# lib/gen-latest-manifest.sh) ────────────────────────────────────────────────
GEN_LATEST_MANIFEST_MERGE_GUI_JSON="$MERGE_GUI" \
GEN_LATEST_MANIFEST_MERGE_SERVER_JSON="$MERGE_SRV" \
  gen_latest_manifest "$VERSION" "$CHANNEL" "$TAG" "${NEW_ARTIFACTS[@]}"

LATEST_JSON="$(gen_latest_manifest_json_path "$TAG")"
LATEST_SERVER_JSON="$(gen_latest_manifest_server_json_path "$TAG")"

# ── [4] extend this tag's recorded artifact-SET with the new files, unioned
# onto whatever it already recorded — typically the other, already-live
# platform's files, still on disk on this single-host setup (WI-5651) ────────
EXISTING_ARTIFACTS=()
if EXISTING_LIST="$(release_artifacts_read "$TAG" 2>/dev/null)"; then
  mapfile -t EXISTING_ARTIFACTS <<< "$EXISTING_LIST"
  echo "==> found ${#EXISTING_ARTIFACTS[@]} already-recorded artifact(s) for $TAG — unioning"
else
  echo "==> no prior artifact-set recorded for $TAG — this is the first platform recorded"
fi
release_artifacts_write "$TAG" "${EXISTING_ARTIFACTS[@]}" "${NEW_ARTIFACTS[@]}" >/dev/null
papercusp_retain_release_paths "${RETENTION_PATHS[@]}" "${NEW_ARTIFACTS[@]}" || exit 1

# ── [5] recurrence guard + hand-off ──────────────────────────────────────────
if release_artifacts_assert_urls_covered "$TAG" "$LATEST_JSON" "$LATEST_SERVER_JSON"; then
  echo "==> recurrence guard: every advertised url is covered by a recorded artifact"
else
  echo "ERROR: the merged manifest advertises an artifact this tag's recorded set does not cover — see above." >&2
  exit 1
fi

# Recurrence guard (EI-20595279927716716): a published download with no .sig cannot
# be verified by anyone. This path NORMALIZES and SIGNS the Windows Server zip in the
# same run, so a well-formed incremental publish passes without special handling.
if release_artifacts_assert_signatures_present "$TAG"; then
  echo "==> signature guard: every signable artifact in $TAG carries its .sig"
else
  echo "ERROR: $TAG would publish an unsigned download — see above. Re-cut with a signing key," >&2
  echo "       or set RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK=1 to ship it knowingly (EI-20595279927716716)." >&2
  exit 1
fi

echo
echo "==> done — merged $PLATFORM into $TAG's manifest without touching other platforms."
echo "    manifest:  $LATEST_JSON"
[[ -f "$LATEST_SERVER_JSON" ]] && echo "    manifest (server): $LATEST_SERVER_JSON"
echo "    publish with:  bin/upload-release.sh $VERSION $CHANNEL"
