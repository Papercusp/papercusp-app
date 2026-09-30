#!/usr/bin/env bash
#
# upload-release.sh — push a cut's artifacts + latest.json to the release host.
#
# This is the LAST STEP of a release, and it replaces hand-uploading to Google
# Drive (which cannot serve auto-update at all: files over ~100MB come back as an
# HTML virus-scan interstitial instead of bytes, so the updater's minisign check
# fails on a page of HTML).
#
# Plan: desktop-release-hosting-r2-2026-07-12 (D-001..D-003). Related: WI-4389
# (auto-update was dead on the local-only rail), WI-4364, WI-3875.
#
#   Usage:  bin/upload-release.sh <version> <channel>          # e.g. 0.0.8 alpha
#           DRY_RUN=1 bin/upload-release.sh 0.0.8 alpha        # print, upload nothing
#
# Layout it writes (object keys are relative to the bucket root, and the custom
# domain maps the bucket root to https://dl.papercusp.com/):
#
#   <secret>/latest.json                 ← the updater manifest. PERMANENT address.
#   <secret>/<channel>/latest.json       ← the per-channel feed (additive)
#   <secret>/<tag>/<artifact>            ← installers + their .sig files
#
# The per-channel feed is ADDITIVE and changes nothing for an existing install:
# every shipped binary polls the permanent root address, which is still written
# exactly as before. A side-by-side channel (nightly — its own bundle id, name
# and data home) writes ONLY its own feed and never the root, because the root
# is polled by every installed copy of the MAIN app.
#
# The <secret> path segment (not a subdomain — D-002: a random subdomain is
# published to Certificate Transparency the moment it gets a cert) comes from
# ~/.papercusp/release-host.env and is PERMANENT (D-003): every shipped app has
# <base>/latest.json baked in, so changing it silently strands every install.
#
# Credentials live in ~/.papercusp/r2.env (never in git):
#   R2_ACCOUNT_ID=...
#   R2_BUCKET=...
#   AWS_ACCESS_KEY_ID=...          # an R2 API token's access key
#   AWS_SECRET_ACCESS_KEY=...
#
set -euo pipefail

VERSION="${1:-}"
CHANNEL="${2:-alpha}"
DRY_RUN="${DRY_RUN:-0}"

if [[ -z "$VERSION" ]]; then
  echo "usage: bin/upload-release.sh <version> [channel]    (e.g. 0.0.8 alpha)" >&2
  exit 2
fi

TAG="desktop-v${VERSION}"
[[ "$CHANNEL" != "stable" ]] && TAG="${TAG}-${CHANNEL}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

# ── Config: where it goes ────────────────────────────────────────────────────
RELEASE_HOST_ENV="${HOME}/.papercusp/release-host.env"
if [[ ! -f "$RELEASE_HOST_ENV" ]]; then
  echo "ERROR: $RELEASE_HOST_ENV not found — no release host configured." >&2
  echo "       See plan desktop-release-hosting-r2-2026-07-12 (P-001)." >&2
  exit 1
fi
# shellcheck source=/dev/null
set -a; . "$RELEASE_HOST_ENV"; set +a
BASE="${PAPERCUSP_UPDATE_BASE_URL:-${PAPERCUSP_RELEASE_HOST:-}}"
if [[ -z "$BASE" ]]; then
  echo "ERROR: neither PAPERCUSP_UPDATE_BASE_URL nor PAPERCUSP_RELEASE_HOST set in $RELEASE_HOST_ENV" >&2
  exit 1
fi
# The object-key prefix is whatever path the base URL carries (the secret).
KEY_PREFIX="$(printf '%s' "$BASE" | sed -E 's#^https?://[^/]+/?##; s#/$##')"
if [[ -z "$KEY_PREFIX" ]]; then
  echo "ERROR: base URL '$BASE' has no path segment — the secret must live in the PATH (D-002)." >&2
  exit 1
fi

# ── Credentials ──────────────────────────────────────────────────────────────
R2_ENV="${HOME}/.papercusp/r2.env"
if [[ ! -f "$R2_ENV" ]]; then
  echo "ERROR: $R2_ENV not found — R2 credentials are owner-provisioned (P-002)." >&2
  echo "       Expected: R2_ACCOUNT_ID, R2_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY" >&2
  exit 1
fi
# shellcheck source=/dev/null
set -a; . "$R2_ENV"; set +a
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID in $R2_ENV}"
: "${R2_BUCKET:?set R2_BUCKET in $R2_ENV}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID in $R2_ENV}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY in $R2_ENV}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

command -v aws >/dev/null 2>&1 || { echo "ERROR: aws CLI not on PATH (R2 is S3-compatible)." >&2; exit 1; }

# R2 does not implement the trailing-checksum headers newer aws-cli v2 sends by
# default; without these it rejects the upload with an opaque 501/400.
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"

s3() { aws s3 --endpoint-url "$ENDPOINT" "$@"; }

# Size of an object in the bucket, or empty if it is not there. Used to prove the
# bytes landed without depending on the public hostname being bound yet.
s3api_head() {
  aws s3api head-object --endpoint-url "$ENDPOINT" \
    --bucket "$R2_BUCKET" --key "$1" \
    --query 'ContentLength' --output text 2>/dev/null || true
}

# ETag of an object in the bucket (quotes stripped), or empty if it is not there.
#
# For a NON-multipart upload the ETag IS the MD5 of the object's content, so it
# settles byte-identity outright. A MULTIPART upload instead yields
# "<md5-of-the-part-md5s>-<partcount>" — the `-N` suffix is how you tell them
# apart, and such a value is NOT comparable to any local hash. `aws s3 cp` goes
# multipart above 8 MiB, so in practice: every small companion file (.sig,
# .json, .txt) gets a real content check, and only the multi-GB artifacts fall
# back to size.
s3api_head_etag() {
  local etag
  # Do not turn an unavailable authenticated metadata read into an empty,
  # apparently-valid value. `remote_state` must distinguish a real multipart
  # ETag from a transport/auth/provider failure; otherwise a failed lookup
  # falls through to the size-only path and can skip a stale large artifact.
  etag="$(aws s3api head-object --endpoint-url "$ENDPOINT" \
    --bucket "$R2_BUCKET" --key "$1" \
    --query 'ETag' --output text 2>/dev/null)" || return 1
  etag="${etag//\"/}"
  [[ -n "$etag" && "$etag" != "None" ]] || return 1
  printf '%s\n' "$etag"
}

# The sha256 WE recorded on the object at upload time, or empty.
#
# This is the fix for the one gap the ETag cannot close. Above 8 MiB an ETag is
# "<md5-of-part-md5s>-<n>", which is not comparable to any local hash, so a
# multi-GB artifact had no content proof at all and fell back to SIZE. A rebuilt
# artifact is very often byte-different at an IDENTICAL size (same inputs, same
# compression settings), so that fallback skipped real changes — see the verdict
# table below. User metadata sidesteps multipart entirely: we put the hash there
# ourselves, so it stays comparable no matter how the object was chunked.
s3api_head_sha256() {
  local v
  v="$(aws s3api head-object --endpoint-url "$ENDPOINT" \
    --bucket "$R2_BUCKET" --key "$1" \
    --query 'Metadata.sha256' --output text 2>/dev/null)" || return 1
  [[ -n "$v" && "$v" != "None" ]] || return 1
  printf '%s\n' "$v"
}

# LastModified of the published object as a unix epoch, or empty.
#
# Only used for objects predating the sha256 metadata above: for those there is
# still no content proof, but "the local file was rebuilt AFTER this object was
# published" is a strong, cheap staleness signal, and it fails in the safe
# direction (an unnecessary re-upload, never a skipped stale artifact).
s3api_head_mtime_epoch() {
  local v
  v="$(aws s3api head-object --endpoint-url "$ENDPOINT" \
    --bucket "$R2_BUCKET" --key "$1" \
    --query 'LastModified' --output text 2>/dev/null)" || return 1
  [[ -n "$v" && "$v" != "None" ]] || return 1
  date -u -d "$v" +%s 2>/dev/null || return 1
}

# The local content hash, in the exact form recorded as object metadata.
local_sha256() { sha256sum "$1" | cut -d' ' -f1; }

# Anything at or below this is never worth a size-only guess: re-pushing it
# costs nothing, and the skip exists solely to avoid re-pushing GIGABYTES.
# Matches the aws multipart threshold, i.e. exactly the boundary at which an
# ETag stops being a usable content hash.
SMALL_ARTIFACT_BYTES=$((8 * 1024 * 1024))

# Compare a local file against the published object and say what is ACTUALLY
# known about them. Echoes exactly one of:
#
#   absent          — nothing published at that key
#   identical       — content PROVEN equal (recorded sha256 matched, or the
#                            ETag was a real MD5 and matched)
#   differs         — content PROVEN different (size differs, or a recorded
#                            sha256 / real-MD5 ETag mismatched)
#   local-newer     — sizes agree, NO content proof is available (a legacy
#                            object with no recorded sha256), and the local file
#                            was modified AFTER the object was published. Not
#                            proof of difference, but the exact shape of a stale
#                            upload: re-push rather than guess.
#   size-only-match       — sizes agree and a valid multipart ETag is present,
#                            but its content hash is not comparable AND the
#                            object is at least as new as the local file
#   metadata-unavailable  — the remote object exists at this size, but its
#                            authenticated ETag metadata could not be read;
#                            this is NEVER evidence of byte identity
#
# The last verdict is the whole point of this function. `upload-release.sh` used
# to treat "same size" as "same file" for every artifact, and its own comment
# justified that with "a re-cut with the same version but different bytes is a
# size change in practice". That is FALSE for exactly the files whose entire job
# is byte-identity: a minisign signature is FIXED-LENGTH (428 B here), so a
# re-cut produces a genuinely different .sig at an identical size, the skip
# fires, and the NEW artifact ends up published beside the OLD artifact's
# signature. Anyone who then does the right thing — download the artifact,
# verify it against the published signature — gets a MISMATCH on a clean
# release, which is indistinguishable from tampering. Measured live on the
# 0.0.17 Windows GUI re-publish (EI-20592319474283246).
remote_state() {
  local key="$1" file="$2" local_size remote_size etag
  local_size="$(stat -c%s "$file")"
  remote_size="$(s3api_head "$key")"
  if [[ -z "$remote_size" || "$remote_size" == "None" ]]; then
    echo absent; return
  fi
  if [[ "$remote_size" != "$local_size" ]]; then
    echo differs; return
  fi
  # The sha256 WE recorded beats every other signal, because it is the only one
  # that stays comparable across multipart chunking. Checked BEFORE the ETag so a
  # multi-GB artifact gets a real content verdict instead of the size guess that
  # let a stale AppImage ship under a fresh signature (EI-23963309971611146).
  local recorded_sha
  if recorded_sha="$(s3api_head_sha256 "$key")"; then
    if [[ "$recorded_sha" == "$(local_sha256 "$file")" ]]; then
      echo identical
    else
      echo differs
    fi
    return
  fi

  if ! etag="$(s3api_head_etag "$key")"; then
    echo metadata-unavailable
    return
  fi
  if [[ "$etag" =~ ^[0-9a-f]{32}$ ]]; then
    if [[ "$etag" == "$(md5sum "$file" | cut -d' ' -f1)" ]]; then
      echo identical
    else
      echo differs
    fi
    return
  fi
  # Only the documented multipart shape earns the size-only fallback. An
  # opaque/malformed ETag (or a provider-specific response) is unknown, not
  # proof that the same-size bytes are safe to skip.
  if [[ "$etag" =~ ^[0-9a-fA-F]{32}-[0-9]+$ ]]; then
    # A legacy multipart object with no recorded sha256: still no content proof.
    # Before falling back to the size guess, ask the one cheap question that
    # actually distinguishes the stale case — was the local file rebuilt AFTER
    # this object was published? If so it is very likely the object is stale, and
    # the safe direction is an unnecessary re-upload rather than a skipped one.
    local remote_epoch local_epoch
    if remote_epoch="$(s3api_head_mtime_epoch "$key")" \
       && local_epoch="$(stat -c%Y "$file" 2>/dev/null)" \
       && [[ -n "$remote_epoch" && -n "$local_epoch" ]] \
       && (( local_epoch > remote_epoch )); then
      echo local-newer
      return
    fi
    echo size-only-match
  else
    echo metadata-unavailable
  fi
}

# ── What to upload ───────────────────────────────────────────────────────────
# NOTE: there is deliberately no $BUNDLE here. Since EI-12913 this script consumes
# the ONE artifact list the builder wrote (release_artifacts_read, below) and hard-
# fails when it is missing or empty — it never globs a bundle dir. A vestigial
# BUNDLE=${CARGO_TARGET_DIR:-$HOME/.cargo-target}/release/bundle sat here unused
# until EI-18103803991060000; it was removed rather than repointed, because reading
# it implied this path depends on a bundle root that it does not.
LATEST_JSON="/tmp/papercusp-latest-${TAG}.json"
# WI-4404: the Server product's own manifest. Optional — release-local.sh only
# writes it when the cut actually produced Server-role artifacts
# (PAPERCUSP_BUILD_ROLES="gui" skips it entirely), so its absence here is not
# an error; it just means this upload carries no Server update this time.
LATEST_SERVER_JSON="/tmp/papercusp-latest-server-${TAG}.json"

if [[ ! -f "$LATEST_JSON" ]]; then
  echo "ERROR: $LATEST_JSON not found — run bin/release-local.sh $VERSION $CHANNEL first." >&2
  exit 1
fi

# Refuse to publish a manifest that names a download location that does not
# exist. Serving this is worse than serving nothing: the updater would offer an
# update and then fail to fetch it. (WI-4364; the operator refuses it too.)
if grep -q 'papercusp-update-base-unset://' "$LATEST_JSON"; then
  echo "ERROR: $LATEST_JSON still contains PLACEHOLDER urls — it was cut without" >&2
  echo "       PAPERCUSP_UPDATE_BASE_URL. Regenerate it before uploading (WI-4364)." >&2
  exit 1
fi
if [[ -f "$LATEST_SERVER_JSON" ]] && grep -q 'papercusp-update-base-unset://' "$LATEST_SERVER_JSON"; then
  echo "ERROR: $LATEST_SERVER_JSON still contains PLACEHOLDER urls — it was cut without" >&2
  echo "       PAPERCUSP_UPDATE_BASE_URL. Regenerate it before uploading (WI-4364)." >&2
  exit 1
fi

# EI-12913: consume the ONE artifact set release-local.sh already computed
# (bin/lib/release-artifacts.sh) instead of re-deriving it here with a second
# glob. The old glob scanned $BUNDLE/{deb,appimage,dmg,macos,nsis,msi} — which has
# NO `inno` dir (where the windows artifacts actually land) and still named the
# retired `nsis` packager — and its extension allowlist EXCLUDED `.bin`, so it
# could not see the windows installer at all AND would have dropped every Server
# DiskSpanning .bin slice (the ~4 GB payload; the .exe alone is a ~3.6 MB stub).
# One list, written by the builder, read here — no drift.
# shellcheck source=lib/release-artifacts.sh
. "$HERE/lib/release-artifacts.sh"
# desktop_channel_feed_paths — which manifest keys this channel publishes.
# shellcheck source=lib/gen-latest-manifest.sh
. "$HERE/lib/gen-latest-manifest.sh"
mapfile -t ARTIFACTS < <(release_artifacts_read "$TAG") || {
  echo "ERROR: could not resolve this cut's artifacts for $TAG — run bin/release-local.sh $VERSION $CHANNEL first (it writes the manifest this reads)." >&2
  exit 1
}

if [[ ${#ARTIFACTS[@]} -eq 0 ]]; then
  echo "ERROR: no artifacts recorded for $TAG" >&2
  exit 1
fi

# EI-20551860898590077: the artifact manifest is tag-scoped, but a failed cut
# can leave a correctly named/signed artifact from an earlier attempt in that
# same directory. Check every raw manifest entry (including missing files) before
# any publish hop; a missing or malformed stamp also fails closed.
if ! release_artifacts_assert_fresh "$TAG"; then
  echo "ERROR: this cut contains a missing or stale artifact — refusing to publish same-version bytes from before the cut start (EI-20551860898590077)." >&2
  exit 1
fi

# EI-20287537474245593: the final publish hand-off must prove that every
# platform in this cut passed the canonical installed-artifact smoke against
# THESE bytes. Receipts are tag/version/platform scoped and re-hashed here, so a
# copied or pre-rebuild PASS cannot authorize a changed payload. The only bypass
# is the shared explicit flag + non-empty reason, which logs the exception.
if ! release_artifacts_run_smoke_receipts "$TAG" "$VERSION" "${ARTIFACTS[@]}"; then
  echo "ERROR: this cut is built but its automatic installed-artifact smoke did not produce valid receipts for the exact platform bytes — refusing upload (EI-20287537474245593)." >&2
  echo "       Configure PAPERCUSP_PLATFORM_SMOKE_CMD for a role-specific remote rig," >&2
  echo "       or set PAPERCUSP_SKIP_PLATFORM_SMOKE=1 AND PAPERCUSP_SKIP_PLATFORM_SMOKE_REASON" >&2
  echo "       for a deliberate, logged hardware-unavailable exception." >&2
  exit 1
fi

# Recurrence guard (EI-12913): every artifact URL the manifest(s) ADVERTISE must
# be in the set we are about to upload. Fail BEFORE uploading — the post-upload
# fetch-check below catches an advertised-but-missing artifact only once the
# manifest lie is already live. latest-server.json is optional (only Server cuts
# emit it) and skipped if absent.
if ! release_artifacts_assert_urls_covered "$TAG" "$LATEST_JSON" "$LATEST_SERVER_JSON"; then
  echo "ERROR: latest.json advertises artifact(s) not in this cut's upload set — the manifest would lie. Fix the cut before shipping (EI-12913)." >&2
  exit 1
fi

# Recurrence guard (EI-20595279927716716): every user-facing artifact we are about
# to publish must carry its sibling .sig, so a download can be VERIFIED. Signing
# used to follow the updater pipeline, so anything assembled after the bundler —
# the Windows Server zip — shipped unsigned in 0.0.16 AND 0.0.17 with nothing
# noticing. Fails closed; the .dmg deferral (WI-39600) prints rather than hides.
if ! release_artifacts_assert_signatures_present "$TAG"; then
  echo "ERROR: this cut would publish a download with no signature — nobody could verify it (EI-20595279927716716)." >&2
  echo "       Re-cut so the artifact is signed (a keyless build cannot sign; see bin/setup-signing-key.sh)," >&2
  echo "       or, for a deliberate legacy re-publish of an already-shipped unsigned set, re-run with" >&2
  echo "       RELEASE_ARTIFACTS_NO_SIGNATURE_CHECK=1 — which records that you shipped it knowingly." >&2
  exit 1
fi

echo "==> release host : ${BASE%/*}/<secret>"
# NEVER print the raw KEY_PREFIX — it is the unguessable path segment that keeps
# the bucket unlisted (D-002/D-003), so it is a masked secret (must never reach a
# transcript / PG / a shared log). This preview is meant to be safe to paste into
# a status update, INCLUDING under DRY_RUN, so it masks the prefix the same way
# line 161 masks the host path. (An agent's mask-sed around DRY_RUN output missed
# it here on 2026-07-17 because there is no KEY_PREFIX env var to grep — it is
# derived from PAPERCUSP_UPDATE_BASE_URL — so the preview must self-mask.)
echo "==> bucket       : s3://${R2_BUCKET}/<secret>/"
echo "==> tag          : $TAG"
echo "==> artifacts    : ${#ARTIFACTS[@]}"
for f in "${ARTIFACTS[@]}"; do
  printf '      %10.2f GB  %s\n' "$(echo "scale=2; $(stat -c%s "$f")/1000000000" | bc)" "$(basename "$f")"
done
echo

# ── GUARD (WI-37738): do the BINARIES point at the prefix we are publishing to? ──
# The failure this exists to stop, which shipped for real on 2026-07-28:
# the release host is baked into the binary at COMPILE time (option_env!
# PAPERCUSP_RELEASE_HOST → baked_release_host() in main.rs), while the publish
# target below is read from the environment at UPLOAD time. Re-point the host
# between build and upload — or build on a box with a stale release-host.env —
# and you produce binaries that ask the OLD prefix forever, then upload them to
# the NEW one. Nothing errors. Every install from that build is permanently
# stranded: the old prefix keeps answering 200 with a frozen manifest, so the
# app is told it is current and never updates again. It took ~2 weeks and a
# real-VM verification pass to notice.
#
# Fails on a PROVEN mismatch; warns (never blocks) when it cannot see inside the
# artifacts, because a compressed artifact yielding no strings is not evidence of
# anything. Set ALLOW_HOST_MISMATCH=1 to override deliberately.
BASE_HOST="$(printf '%s' "$BASE" | sed -E 's#^https?://([^/]+).*#\1#')"
echo "==> verifying baked release host in artifacts (expect prefix: <secret>)"
host_checked=0
host_bad=0
for f in "${ARTIFACTS[@]}"; do
  # Only uncompressed artifacts expose the baked string; a .tar.gz/.zip legitimately
  # yields nothing and is SKIPPED rather than counted as agreement.
  found="$(strings -a "$f" 2>/dev/null \
    | grep -oE "https?://${BASE_HOST}/[A-Za-z0-9_-]+" \
    | sed -E "s#^https?://${BASE_HOST}/##" | sort -u)" || true
  [[ -z "$found" ]] && continue
  host_checked=$((host_checked + 1))
  while IFS= read -r prefix; do
    [[ -z "$prefix" ]] && continue
    if [[ "$prefix" != "$KEY_PREFIX" ]]; then
      host_bad=$((host_bad + 1))
      echo "    ✗ $(basename "$f") is baked to a DIFFERENT prefix than we are publishing to" >&2
    fi
  done <<< "$found"
done

if [[ "$host_bad" -gt 0 ]]; then
  if [[ "${ALLOW_HOST_MISMATCH:-0}" == "1" ]]; then
    echo "    ⚠ baked-host mismatch OVERRIDDEN by ALLOW_HOST_MISMATCH=1 — every install from this build will be stranded on the wrong prefix." >&2
  else
    echo >&2
    echo "ERROR: these binaries ask a DIFFERENT release prefix than the one being published to." >&2
    echo "       Shipping them strands every install from this build PERMANENTLY: the prefix they" >&2
    echo "       ask keeps answering, so the app is told it is up to date and never updates again." >&2
    echo "       Rebuild with the CURRENT ~/.papercusp/release-host.env in the environment, so the" >&2
    echo "       baked host matches the upload target. (WI-37738. ALLOW_HOST_MISMATCH=1 to override.)" >&2
    exit 1
  fi
elif [[ "$host_checked" -gt 0 ]]; then
  echo "    ✓ ${host_checked} artifact(s) carry the prefix being published to"
fi
# NOTE: the host_checked==0 case is NOT decided here any more — it is decided by
# the combined verdict below, after the byte and provenance legs have had their say.

# ── GUARD leg 2 (WI-37746): the DECISIVE, non-heuristic host check ────────────
# The strings scan above is necessary but NOT sufficient, and its blind spot is
# the WORSE half of the failure class. It greps for the CURRENT host
# (${BASE_HOST}), so an artifact baked to a DIFFERENT HOST matches nothing, is
# `continue`d rather than counted, and falls through to "could not read a baked
# host" — which, before this leg existed, was a warning that SHIPPED.
#
# Measured on fixtures 2026-08-11, publishing to host H prefix P:
#   baked H/P        -> verified OK
#   baked H/OTHER    -> BLOCKS (exit 1)      <- the scan works for prefix drift
#   baked OTHER/...  -> WARNS ONLY, SHIPS    <- the silent stranding path
# Compressed artifacts (.tar.gz/.dmg) reach that same warning for an unrelated
# reason, so on a mac-only cut the scan can verify NOTHING at all.
#
# Hence the evidence cannot come from the shipped bytes; it comes from the BUILD,
# where the baked value is known for certain. emit-build-provenance.sh records it
# as `releaseHostSha256` — a fingerprint, never the URL, because this file ships
# next to the artifacts and the URL's path segment is the masked secret.
EXPECTED_HOST_FP="$(printf '%s' "${BASE%/}" | sha256sum | cut -d' ' -f1)"
prov_checked=0; prov_bad=0; prov_legacy=0
while IFS= read -r pdir; do
  prov="$pdir/build-provenance.json"
  [[ -f "$prov" ]] || continue
  got="$(python3 -c "
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print('__UNREADABLE__'); raise SystemExit(0)
if 'releaseHostSha256' not in d: print('__MISSING__')
elif d['releaseHostSha256'] is None: print('__NULL__')
else: print(d['releaseHostSha256'])
" "$prov" 2>/dev/null || printf '__UNREADABLE__')"
  case "$got" in
    __MISSING__|__NULL__|__UNREADABLE__|'')
      # MISSING = a pre-WI-37746 emitter; NULL = nothing was baked. Neither is
      # evidence of agreement, so neither counts as a check.
      prov_legacy=$((prov_legacy + 1)) ;;
    *)
      prov_checked=$((prov_checked + 1))
      if [[ "$got" != "$EXPECTED_HOST_FP" ]]; then
        prov_bad=$((prov_bad + 1))
        # Print only a truncated fingerprint: it is a hash of the secret base URL.
        echo "    ✗ $(basename "$pdir")/build-provenance.json: built for release host ${got:0:12}… but publishing to ${EXPECTED_HOST_FP:0:12}…" >&2
      fi ;;
  esac
done < <(printf '%s\n' "${ARTIFACTS[@]}" | xargs -r -n1 dirname | sort -u)

if [[ "$prov_bad" -gt 0 ]]; then
  if [[ "${ALLOW_HOST_MISMATCH:-0}" == "1" ]]; then
    echo "    ⚠ provenance host mismatch OVERRIDDEN by ALLOW_HOST_MISMATCH=1 — every install from this build will be stranded on the wrong host." >&2
  else
    echo >&2
    echo "ERROR: this cut's BUILD PROVENANCE says these binaries were built for a DIFFERENT release host" >&2
    echo "       than the one being published to. Shipping them strands every install from this build" >&2
    echo "       PERMANENTLY: the host they ask keeps answering with a frozen manifest, so the app is" >&2
    echo "       told it is up to date and never updates again — the WI-37738 failure, which took ~2" >&2
    echo "       weeks and a real-VM pass to notice. Rebuild with the CURRENT ~/.papercusp/release-host.env" >&2
    echo "       in the environment. (WI-37746. ALLOW_HOST_MISMATCH=1 to override deliberately.)" >&2
    exit 1
  fi
elif [[ "$prov_checked" -gt 0 ]]; then
  echo "    ✓ ${prov_checked} build-provenance record(s) confirm these bytes were built for this exact host"
fi

# ── GUARD leg 3 (WI-37746): derive proof from the bytes themselves ───────────
# A repack/re-publish can carry a stale or hand-written build-provenance file.
# Read the payload bytes independently, including compressed package contents,
# so the host agreement check is about what will actually ship. Signature
# companions are intentionally skipped: they sign the payload and do not carry
# the updater URL. The helper prints only basenames and truncated fingerprints;
# the release path is never copied into the upload transcript.
byte_checked=0; byte_bad=0; byte_unverified=0; byte_skipped_signatures=0; byte_proof_rc=0
if byte_proof_output="$(release_artifacts_assert_baked_host_from_bytes "$BASE" "${ARTIFACTS[@]}" 2>&1)"; then
  byte_proof_rc=0
else
  byte_proof_rc=$?
fi
printf '%s\n' "$byte_proof_output"
byte_summary="$(printf '%s\n' "$byte_proof_output" | grep -E '^release-host-bytes: checked=' | tail -n 1)" || true
if [[ "$byte_summary" =~ checked=([0-9]+)[[:space:]]mismatched=([0-9]+)[[:space:]]unverified=([0-9]+)[[:space:]]skipped-signatures=([0-9]+) ]]; then
  byte_checked="${BASH_REMATCH[1]}"
  byte_bad="${BASH_REMATCH[2]}"
  byte_unverified="${BASH_REMATCH[3]}"
  byte_skipped_signatures="${BASH_REMATCH[4]}"
else
  byte_unverified=1
  echo "    ⚠ byte-derived host proof produced no complete verdict (exit ${byte_proof_rc})" >&2
fi

if [[ "$byte_bad" -gt 0 ]]; then
  if [[ "${ALLOW_HOST_MISMATCH:-0}" == "1" ]]; then
    echo "    ⚠ byte-derived host mismatch OVERRIDDEN by ALLOW_HOST_MISMATCH=1 — ${byte_bad} artifact(s) contain a foreign/mixed host fingerprint; byte-proof gaps=${byte_unverified}, signatures-skipped=${byte_skipped_signatures}." >&2
  else
    echo >&2
    echo "ERROR: the published artifact bytes contain a DIFFERENT release host." >&2
    echo "       The byte-derived proof found ${byte_bad} mismatched artifact(s); this is a decisive host/target disagreement." >&2
    echo "       Rebuild or repack from the current release host, or re-run only after deliberately setting ALLOW_HOST_MISMATCH=1." >&2
    echo "       (WI-37746; byte-proof gaps=${byte_unverified}, signatures-skipped=${byte_skipped_signatures}.)" >&2
    exit 1
  fi
elif [[ "$byte_unverified" -gt 0 ]]; then
  echo "    ⚠ byte-derived host proof has ${byte_unverified} unverified artifact(s); compressed/uninspectable payloads remain a proof gap." >&2
fi

# Combined verdict: NONE of the three independent legs could establish agreement ⇒ REFUSE.
#
# This used to be a warning that shipped, and measurement is what changed it.
# Running this script against the REAL, already-published 0.0.15 cut on
# 2026-08-11 produced host_checked=0 AND prov_checked=0: all 16 artifacts are
# compressed (AppImage/.deb/.dmg/.tar.gz/.exe/.zip), so `strings` exposed no
# baked host in ANY of them, and the one provenance record predated
# releaseHostSha256. So "UNVERIFIED" was not a rare corner — it was the ROUTINE
# outcome on the release that actually shipped, which is exactly how a warning
# gets waved through and how WI-37738 stranded every install for ~2 weeks.
#
# Now that emit-build-provenance.sh always records releaseHostSha256, a cut
# built through the normal path ALWAYS has decisive evidence, so reaching here
# means something genuinely unusual: artifacts assembled outside the build, or a
# provenance file that never made it next to them. Fail closed and make the
# operator say so out loud, rather than letting the routine case stay silent.
if [[ "$host_checked" -eq 0 && "$prov_checked" -eq 0 && "$byte_checked" -eq 0 ]]; then
  if [[ "${ALLOW_HOST_MISMATCH:-0}" == "1" ]]; then
    echo "    ⚠ UNVERIFIED host/target agreement OVERRIDDEN by ALLOW_HOST_MISMATCH=1 — no leg proves these binaries point at this prefix (byte-proof: checked=${byte_checked}, mismatched=${byte_bad}, gaps=${byte_unverified}, signatures-skipped=${byte_skipped_signatures})." >&2
  else
    echo >&2
    echo "ERROR: host/target agreement is UNVERIFIED for this cut, so this upload is REFUSED." >&2
    echo "       The artifacts expose no baked host to \`strings\` (all compressed is normal), AND no" >&2
    echo "       byte-derived proof agrees (checked=${byte_checked}, mismatched=${byte_bad}, gaps=${byte_unverified}, signatures-skipped=${byte_skipped_signatures}), AND no" >&2
    echo "       build-provenance record carries releaseHostSha256 (${prov_legacy} legacy/absent record(s))." >&2
    echo "       Nothing here proves these binaries poll the prefix being published to — and shipping a" >&2
    echo "       build that polls the WRONG one strands every install from it permanently (WI-37738)." >&2
    echo "       Re-cut so bin/emit-build-provenance.sh records the baked host, or, if you are" >&2
    echo "       deliberately re-uploading a pre-WI-37746 cut whose host you have confirmed by hand," >&2
    echo "       re-run with ALLOW_HOST_MISMATCH=1. (WI-37746.)" >&2
    exit 1
  fi
fi
echo

# Refuse an unapproved reduced desktop scope before writing either artifact
# objects or updater manifests. The registry recorder enforces the same owner
# directive at record time; this repeats it at the publication boundary.
if ! npx tsx "${REPO_ROOT}/apps/operator/lib/release/finalize-release-publication.ts" \
    --preflight \
    --version "$VERSION" \
    --channel "$CHANNEL" \
    --workspace "${PAPERCUSP_WORKSPACE_ID:-papercusp-workspace}"; then
  echo "ERROR: release scope preflight failed — refusing to upload artifacts or updater manifests." >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN=1 — nothing uploaded."
  exit 0
fi

# ── Upload artifacts FIRST, manifest LAST ────────────────────────────────────
# Order matters: latest.json is what makes an update VISIBLE to every installed
# app. Publishing it before the bytes it points at exist would advertise an
# update that 404s for anyone who checks in the meantime.
# Skip anything already published that is PROVABLY the same bytes. These
# artifacts are ~4 GB each, and the common reason to re-run this script is to
# complete the HTTPS verification after the custom domain was bound — re-pushing
# 11 GB to re-learn what we already know is pure waste.
#
# The skip is decided by `remote_state`, which compares CONTENT wherever content
# can be compared and only falls back to size for genuinely multipart (i.e.
# multi-GB) objects. It deliberately does NOT trust size for small files: see the
# fixed-length-signature failure documented on `remote_state` above.
for f in "${ARTIFACTS[@]}"; do
  name="$(basename "$f")"
  local_size="$(stat -c%s "$f")"
  case "$(remote_state "${KEY_PREFIX}/${TAG}/${name}" "$f")" in
    identical)
      echo "==> already uploaded, content verified identical — skipping $name"
      continue
      ;;
    local-newer)
      # Same size, no content proof, but the local file is NEWER than the
      # published object. That is the exact fingerprint of the stale-artifact
      # bug: a rebuilt artifact is routinely byte-different at an identical size,
      # so a size match here is worth nothing. Re-push (EI-23963309971611146).
      echo "==> re-uploading $name (same size, but the local file is NEWER than the published object — size is not evidence)"
      ;;
    size-only-match)
      # Sizes agree and nothing proved the bytes do. This is now reachable ONLY
      # for a legacy object with no recorded sha256 that is also at least as new
      # as the local file. Every object this script uploads from now on carries a
      # sha256, so this branch shrinks to nothing as old releases age out.
      if (( local_size > SMALL_ARTIFACT_BYTES )); then
        echo "==> $name: size matches but content is NOT verifiable (legacy multipart object, no recorded sha256) — skipping" >&2
        echo "    If this artifact was rebuilt, re-run with PAPERCUSP_FORCE_REUPLOAD=1; size alone cannot tell." >&2
        if [[ "${PAPERCUSP_FORCE_REUPLOAD:-0}" == "1" ]]; then
          echo "==> PAPERCUSP_FORCE_REUPLOAD=1 — uploading $name anyway"
        else
          continue
        fi
      else
        echo "==> re-uploading $name (same size, but content could not be verified and it is small)"
      fi
      ;;
    metadata-unavailable)
      echo "==> remote content metadata unavailable — uploading $name instead of trusting its size"
      ;;
  esac
  echo "==> uploading $name"
  # Record the content hash AS OBJECT METADATA. This is what makes the next run's
  # comparison exact: an ETag stops being a content hash above 8 MiB, but this
  # value is ours and survives multipart chunking untouched.
  s3 cp "$f" "s3://${R2_BUCKET}/${KEY_PREFIX}/${TAG}/${name}" --only-show-errors \
    --metadata "sha256=$(local_sha256 "$f")"
done

# The manifest goes to EVERY feed path this channel publishes:
#   <secret>/<channel>/latest.json   ← the per-channel feed (always)
#   <secret>/latest.json             ← the PERMANENT address, for update lanes only
#
# The per-channel feed is written FIRST and the root LAST, deliberately: if this
# dies partway, the address every installed app polls forever is still pointing
# at the previous, known good release rather than at a half-published one.
#
# The root leg is exactly what this script has always done — it is preserved
# byte-for-byte so no existing install is affected. The per-channel legs are
# purely additive: nothing reads them until a build ships that knows to.
upload_manifest() {
  local src="$1" manifest_name="$2" label="$3" path
  while IFS= read -r path; do
    if [[ "$path" == "$manifest_name" ]]; then
      echo "==> uploading ${label} to the PERMANENT root address (LAST — this is what publishes the update)"
    else
      echo "==> uploading ${label} to the ${CHANNEL} channel feed (${path})"
    fi
    s3 cp "$src" "s3://${R2_BUCKET}/${KEY_PREFIX}/${path}" \
      --content-type application/json --cache-control 'no-cache, max-age=0' --only-show-errors
  done < <(desktop_channel_feed_paths "$CHANNEL" "$manifest_name")
}

upload_manifest "$LATEST_JSON" "latest.json" "latest.json"

if [[ -f "$LATEST_SERVER_JSON" ]]; then
  echo "==> publishing the Server product's manifest (WI-4404)"
  upload_manifest "$LATEST_SERVER_JSON" "latest-server.json" "latest-server.json"
else
  echo "==> no latest-server.json for this cut — Server product's manifest left as-is"
fi

# ── Verify what actually landed ──────────────────────────────────────────────
# Two INDEPENDENT checks, because they can fail for very different reasons and
# collapsing them hides which one broke:
#
#   1. STORAGE (S3 endpoint, authenticated) — did the bytes land, intact?
#      Always available; a failure here means the upload is genuinely broken.
#   2. PUBLIC READ PATH (https://<host>/…) — can an installed app actually
#      fetch them? This additionally requires the custom domain to be bound to
#      the bucket, which is a one-time Cloudflare setup, NOT a property of this
#      upload. An unbound domain is an expected pre-launch state, not corruption.
echo
echo "==> verifying storage (S3, authenticated)"
# This leg used to read ONLY ContentLength — the same measurement the skip above
# used to make its decision. That is why it could never catch a stale companion
# file: the skip and its verifier shared one derivation, so they agreed because
# they were the same check run twice, not because the bytes matched. It now
# asserts CONTENT wherever content is knowable, which makes it a real detector of
# the failure that produced EI-20592319474283246.
STORAGE_BAD=0
for f in "${ARTIFACTS[@]}"; do
  name="$(basename "$f")"
  local_size="$(stat -c%s "$f")"
  case "$(remote_state "${KEY_PREFIX}/${TAG}/${name}" "$f")" in
    identical)
      printf '  ✓ %s (%.2f GB, content verified)\n' "$name" "$(echo "scale=4; $local_size/1000000000" | bc)"
      ;;
    local-newer)
      echo "  ✗ $name — published object is OLDER than the local file at the same size." >&2
      echo "    That is the stale-artifact fingerprint: a rebuilt artifact is routinely" >&2
      echo "    byte-different at an identical size. (EI-23963309971611146)" >&2
      STORAGE_BAD=1
      ;;
    size-only-match)
      # This used to print a green tick for any artifact over 8 MiB, which is how
      # a STALE AppImage was reported as "verified" on 0.0.21: the check could not
      # see content, so it reported the only thing it could see — the size — and
      # rendered that as success. A verification step that cannot verify must not
      # emit a ✓; "I could not check" and "I checked and it was fine" are
      # different facts and must never share a symbol. (EI-23963309971611146)
      echo "  ✗ $name — published at the right size but its content could NOT be verified." >&2
      if (( local_size > SMALL_ARTIFACT_BYTES )); then
        echo "    Multipart object with no recorded sha256 metadata. Every upload this script" >&2
        echo "    performs now records one, so this means the object predates that or was" >&2
        echo "    written by something else. Size is not evidence of identity." >&2
      else
        echo "    It is small enough that there is no excuse for not knowing." >&2
      fi
      STORAGE_BAD=1
      ;;
    metadata-unavailable)
      echo "  ✗ $name — authenticated remote ETag metadata was unavailable; cannot verify stored bytes." >&2
      STORAGE_BAD=1
      ;;
    absent)
      echo "  ✗ $name — nothing published at ${KEY_PREFIX}/${TAG}/${name}" >&2
      STORAGE_BAD=1
      ;;
    *)
      echo "  ✗ $name — PUBLISHED BYTES DIFFER FROM LOCAL (local ${local_size}B)." >&2
      echo "    A same-size mismatch here is the stale-companion bug: the published file was" >&2
      echo "    left behind by a skip. Anyone verifying this artifact against its published" >&2
      echo "    signature would see what looks exactly like tampering. (EI-20592319474283246)" >&2
      STORAGE_BAD=1
      ;;
  esac
done
if [[ "$STORAGE_BAD" != "0" ]]; then
  echo "ERROR: artifacts did not land intact — NOT a domain problem, the upload is broken." >&2
  exit 1
fi
echo "  ✓ all artifacts published and verified against local bytes"

echo
echo "==> verifying every public manifest feed (${BASE%/*}/<secret>/<feed>)"
PUBLIC_MANIFEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-public-manifests.XXXXXX")"
trap 'rm -rf "$PUBLIC_MANIFEST_DIR"' EXIT

# Fetch one manifest path and prove BOTH identity dimensions:
#   (1) the served bytes equal the local manifest uploaded to this path; and
#   (2) the served document names the VERSION+CHANNEL this invocation intends.
# Byte equality alone is self-referential: a stale local manifest and its stale
# uploaded copy agree perfectly while the release never advances.
verify_public_manifest_identity() {
  local local_manifest="$1" manifest_path="$2" tmp_manifest="$3" label="$4"
  local http_code hostname_only identity served_version served_channel

  # NOTE: on a connection-level failure curl writes "000" via -w AND exits
  # non-zero. Do not append another fallback "000" or it becomes "000000".
  http_code="$(curl -sS -o "$tmp_manifest" -w '%{http_code}' --max-time 30 \
    "${BASE}/${manifest_path}" 2>/dev/null)" || true
  if [[ -z "$http_code" || "$http_code" == "000" ]]; then
    hostname_only="$(printf '%s' "$BASE" | sed -E 's#^https?://([^/]+).*#\1#')"
    echo "  ⚠ ${hostname_only} is not reachable — the artifacts ARE uploaded and intact," >&2
    echo "    but the R2 bucket is not yet published at this hostname, so installed apps" >&2
    echo "    cannot download them. One-time setup, in Cloudflare:" >&2
    echo "      R2 → ${R2_BUCKET} → Settings → Custom Domains → Connect Domain → ${hostname_only}" >&2
    echo "    Re-run this script afterwards to complete the verification." >&2
    return 2
  fi
  if [[ "$http_code" != "200" ]]; then
    echo "  ✗ GET ${manifest_path} returned HTTP $http_code" >&2
    return 1
  fi
  if ! diff -q "$local_manifest" "$tmp_manifest" >/dev/null; then
    echo "  ✗ served ${manifest_path} does NOT match uploaded ${label}" >&2
    return 1
  fi
  if ! identity="$(python3 - "$tmp_manifest" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as source:
    manifest = json.load(source)
if not isinstance(manifest, dict):
    raise SystemExit("served manifest is not a JSON object")
version = manifest.get("version")
channel = manifest.get("channel")
if not isinstance(version, str) or not isinstance(channel, str):
    raise SystemExit("served manifest lacks string version/channel identity")
print(f"{version}\t{channel}")
PY
  )"; then
    echo "  ✗ served ${manifest_path} has malformed release identity" >&2
    return 1
  fi
  IFS=$'\t' read -r served_version served_channel <<< "$identity"
  if [[ "$served_version" != "$VERSION" || "$served_channel" != "$CHANNEL" ]]; then
    echo "  ✗ served ${manifest_path} identifies ${served_version:-<missing>}/${served_channel:-<missing>}, expected ${VERSION}/${CHANNEL}" >&2
    return 1
  fi
  echo "  ✓ ${manifest_path}: byte-identical ${label}, identity ${VERSION}/${CHANNEL}"
}

# Spot-check that each artifact URL the manifest ADVERTISES is actually fetchable
# (no full download — these are gigabytes). Verifying the bucket is not enough:
# what matters is that the exact url a client reads out of the manifest resolves
# to bytes. A manifest pointing at a 404 is the LABELED!=PACKED failure this
# whole rail exists to prevent.
#
# ⚠ MUST send a real User-Agent. Cloudflare's r2.dev public URL bot-blocks the
# default `Python-urllib/x.y` UA with a hard 403 (NOT a rate-limit, NOT
# transient — reproducible 100% of the time), while it serves `curl/*`,
# `reqwest` (what the tauri updater client actually uses), `Mozilla/*`, and any
# non-bot UA with 200. A probe using urllib's default UA therefore false-fails
# an upload that fully succeeded and that every real client can download. So set
# an explicit updater-like UA below; with that in place a 403/404 means a REAL
# permission/missing-object problem worth failing on. A short retry still guards
# a genuinely transient 429/5xx, but we do NOT retry a 403 (with a good UA it is
# real). Probe via range-GET — exactly what tauri-plugin-updater does.
probe_public_manifest_artifacts() {
python3 - "$1" <<'PY'
import json, sys, time, urllib.request, urllib.error
m = json.load(open(sys.argv[1]))
# A real-client UA — r2.dev 403s the default Python-urllib bot UA (see comment).
UA = "Papercusp-Updater (release-verify; reqwest-compatible)"
ATTEMPTS = 3                 # total tries per url (only for transient 429/5xx)
BACKOFF  = [3, 9]            # seconds between transient retries

def probe(url):
    """Return (ok, detail, retryable). Range-GET, mirroring the updater client."""
    req = urllib.request.Request(
        url, method="GET",
        headers={"User-Agent": UA, "Range": "bytes=0-0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return True, f"{r.status} (range-GET ok)", False
    except urllib.error.HTTPError as e:
        # 429/5xx can be transient; 403/404 with a good UA is a real failure.
        return False, f"HTTP {e.code}", e.code == 429 or 500 <= e.code < 600
    except Exception as e:
        return False, str(e), True   # network-level blip: retryable

bad = 0
for key, entry in (m.get("platforms") or {}).items():
    url = entry.get("url", "")
    ok, detail, retryable = False, "no attempt", False
    for i in range(ATTEMPTS):
        ok, detail, retryable = probe(url)
        if ok:
            if i:
                detail += f" (after {i+1} tries)"
            break
        if not retryable or i == ATTEMPTS - 1:
            break
        time.sleep(BACKOFF[min(i, len(BACKOFF) - 1)])
    if ok:
        print(f"  ✓ {key}: {detail}")
    else:
        bad += 1
        print(f"  ✗ {key}: {url} -> {detail}")
if bad:
    sys.exit(f"\n{bad} advertised artifact url(s) are NOT fetchable — the manifest lies. Fix before shipping.")
PY
}

# Verify exactly the paths the existing channel registry told upload_manifest()
# to write. This includes <channel>/latest.json for every channel, the permanent
# root for update lanes, and deliberately NO root for side-by-side nightly.
verify_public_manifest_feeds() {
  local local_manifest="$1" manifest_name="$2" label="$3"
  local manifest_path tmp_manifest count=0
  while IFS= read -r manifest_path; do
    [[ -n "$manifest_path" ]] || continue
    tmp_manifest="$PUBLIC_MANIFEST_DIR/feed-${count}.json"
    verify_public_manifest_identity "$local_manifest" "$manifest_path" "$tmp_manifest" "$label" || return
    probe_public_manifest_artifacts "$tmp_manifest" || return
    count=$((count + 1))
  done < <(desktop_channel_feed_paths "$CHANNEL" "$manifest_name")
  if [[ "$count" -eq 0 ]]; then
    echo "  ✗ channel registry emitted no public path for ${label}" >&2
    return 1
  fi
}

verify_public_manifest_feeds "$LATEST_JSON" "latest.json" "latest.json"
if [[ -f "$LATEST_SERVER_JSON" ]]; then
  verify_public_manifest_feeds "$LATEST_SERVER_JSON" "latest-server.json" "latest-server.json"
fi

# Only after the independent public manifest + artifact probes pass may the
# registry call this release LIVE. The finalizer re-reads the row and repeats
# the public HEAD proof, then uses the workspace-scoped monotonic writer. Keep
# the base URL in the child environment rather than argv: its path is the
# permanent release secret and must not appear in process listings or logs.
echo
echo "==> finalizing release registry publication"
PAPERCUSP_UPDATE_BASE_URL="$BASE" \
  npx tsx "${REPO_ROOT}/apps/operator/lib/release/finalize-release-publication.ts" \
    --version "$VERSION" \
    --channel "$CHANNEL" \
    --workspace "${PAPERCUSP_WORKSPACE_ID:-papercusp-workspace}"

echo
echo "==> done — $TAG is LIVE at the release host."
echo "    Installed apps will see it on their next update check."
