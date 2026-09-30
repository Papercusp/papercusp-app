#!/usr/bin/env bash
# Publish one ACCEPTED PUI archive to the existing Papercusp release host.
#
# This is deliberately separate from papercusp-desktop/bin/upload-release.sh:
# the desktop uploader consumes a desktop artifact manifest and writes the
# desktop updater's root latest.json. PUI has neither contract. It publishes
# under <release-host>/pui/ and owns only pui/latest.json + pui/index.html.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: apps/tui/scripts/publish-release.sh --archive <pui-*.tar.gz> [options]

  --acceptance <f>  exact archive acceptance report (default: <archive>.acceptance.json)
  --sums <f>        published digest file (default: SHA256SUMS beside archive)
  --work <dir>      keep generated publication files in this directory

Environment:
  DRY_RUN=1                  validate + render, upload nothing
  PUI_RELEASE_HOST_ENV       release-host env (default ~/.papercusp/release-host.env)
  PUI_R2_ENV                 R2 credential env (default ~/.papercusp/r2.env)
  PUI_PORTAL_LINKS_ENV       durable Portal build env written after publish
  PUI_SKIP_PORTAL_CONFIG=1   do not update the Portal build env
EOF
}

die() { echo "pui-publish: ERROR: $*" >&2; exit 1; }

ARCHIVE=""
ACCEPTANCE=""
SUMS=""
WORK=""
KEEP_WORK=0
while (($#)); do
  case "$1" in
    --archive) ARCHIVE="${2:?--archive needs a value}"; shift 2 ;;
    --archive=*) ARCHIVE="${1#*=}"; shift ;;
    --acceptance) ACCEPTANCE="${2:?--acceptance needs a value}"; shift 2 ;;
    --acceptance=*) ACCEPTANCE="${1#*=}"; shift ;;
    --sums) SUMS="${2:?--sums needs a value}"; shift 2 ;;
    --sums=*) SUMS="${1#*=}"; shift ;;
    --work) WORK="${2:?--work needs a value}"; KEEP_WORK=1; shift 2 ;;
    --work=*) WORK="${1#*=}"; KEEP_WORK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

[[ -n "$ARCHIVE" ]] || { usage >&2; exit 2; }
for tool in node tar sha256sum; do command -v "$tool" >/dev/null || die "missing required tool: $tool"; done
ARCHIVE="$(realpath "$ARCHIVE")"
[[ -f "$ARCHIVE" ]] || die "archive not found: $ARCHIVE"
ACCEPTANCE="$(realpath "${ACCEPTANCE:-$ARCHIVE.acceptance.json}")"
SUMS="$(realpath "${SUMS:-$(dirname "$ARCHIVE")/SHA256SUMS}")"
[[ -f "$ACCEPTANCE" ]] || die "acceptance report not found: $ACCEPTANCE"
[[ -f "$SUMS" ]] || die "SHA256SUMS not found: $SUMS"

NAME="$(basename "$ARCHIVE")"
if [[ "$NAME" =~ ^pui-(.+)-(linux-x86_64|macos-aarch64|macos-x86_64)\.tar\.gz$ ]]; then
  VERSION="${BASH_REMATCH[1]}"
  TARGET="${BASH_REMATCH[2]}"
else
  die "archive name must be pui-<version>-<supported-target>.tar.gz: $NAME"
fi
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || die "invalid release version"

if [[ -z "$WORK" ]]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/pui-publish.XXXXXX")"
fi
mkdir -p "$WORK"
cleanup() { ((KEEP_WORK)) || rm -rf -- "$WORK"; }
trap cleanup EXIT

DIGEST="$(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
LISTED_DIGEST="$(awk -v name="$NAME" '$2 == name { print $1 }' "$SUMS")"
[[ "$LISTED_DIGEST" == "$DIGEST" ]] || die "archive digest does not match SHA256SUMS"

ROOT_ENTRY="$(tar -tzf "$ARCHIVE" | awk 'NR == 1 { sub(/\/$/, ""); first=$0 } END { print first }')"
[[ "$ROOT_ENTRY" == "pui-$VERSION-$TARGET" ]] || die "archive root '$ROOT_ENTRY' does not match its filename"
tar -xOf "$ARCHIVE" "$ROOT_ENTRY/PROVENANCE.json" > "$WORK/PROVENANCE.json" \
  || die "archive has no readable PROVENANCE.json"

PUI_ACCEPTANCE="$ACCEPTANCE" PUI_PROVENANCE="$WORK/PROVENANCE.json" \
PUI_DIGEST="$DIGEST" PUI_VERSION="$VERSION" PUI_TARGET="$TARGET" PUI_WORK="$WORK" PUI_NAME="$NAME" \
node <<'NODE' > "$WORK/validated.json"
const fs = require('node:fs');
const fail = (message) => { console.error(`pui-publish: ERROR: ${message}`); process.exit(1); };
const acceptance = JSON.parse(fs.readFileSync(process.env.PUI_ACCEPTANCE, 'utf8'));
const provenance = JSON.parse(fs.readFileSync(process.env.PUI_PROVENANCE, 'utf8'));
if (acceptance.ok !== true) fail('acceptance report is not green');
if (!Array.isArray(acceptance.refusals) || acceptance.refusals.length) fail('acceptance report lacks an empty refusal list');
if (!/^[a-f0-9]{40}$/.test(provenance.source?.commit ?? '')) fail('invalid source commit');
if (acceptance.candidate?.archiveSha256 !== process.env.PUI_DIGEST) fail('acceptance report belongs to different archive bytes');
if (acceptance.candidate?.sourceSha !== provenance.source?.commit) fail('acceptance source does not match archive provenance');
if (provenance.version !== process.env.PUI_VERSION || provenance.target !== process.env.PUI_TARGET) {
  fail('archive provenance does not match filename version/target');
}
const stock = acceptance.runner?.stockMachines;
if (process.env.PUI_TARGET.startsWith('linux-') && (!Array.isArray(stock)
  || !['ubuntu:24.04', 'debian:stable-slim'].every((image) => stock.some((row) => row.image === image && row.status === 0))
  || stock.some((row) => row.status !== 0))) {
  fail('Linux publication needs passing Ubuntu and Debian stock-machine smoke');
}
if (acceptance.runner?.cloudDeviceStart?.ok !== true) fail('public cloud device-start guard did not pass');
const legs = acceptance.runner?.legs;
const advertise = acceptance.candidate?.advertise;
if (!Array.isArray(advertise) || advertise.length === 0
  || advertise.some((row) => !['Linux x86_64', 'macOS Apple Silicon', 'macOS Intel', 'WSL2'].includes(row.platform)
    || !['Claude', 'Codex', 'OMP'].includes(row.backend))) fail('advertised platform/backend scope is absent or invalid');
if (!Array.isArray(legs) || !legs.some((row) => row.engine === 'scripted' && row.status === 0)
  || !advertise.every((cell) => legs.some((row) => row.engine === cell.backend.toLowerCase() && row.status === 0))
  || legs.some((row) => row.status !== 0)) {
  fail('installed-product acceptance legs are absent or red');
}
const suite = acceptance.runner?.suiteProvenance;
if (!Array.isArray(suite) || suite.length === 0
  || suite.some((row) => !/^[a-f0-9]{40}$/.test(row.candidateBlob ?? '') || row.candidateBlob !== row.runBlob)) {
  fail('acceptance suite provenance is absent or mismatched');
}
// The local report includes paths, terminal output and account metadata. Publish
// only the structured verdict fields needed to identify and assess these bytes.
const publicReport = {
  schemaVersion: 1, kind: 'public-acceptance-summary', ok: true, refusals: [],
  candidate: { sourceSha: provenance.source.commit, artifact: provenance.target,
    archiveSha256: process.env.PUI_DIGEST, advertise },
  runner: {
    stockMachines: stock.filter((row) => ['ubuntu:24.04', 'debian:stable-slim'].includes(row.image))
      .map((row) => ({ image: row.image, status: row.status })),
    cloudDeviceStart: { ok: true },
    legs: legs.filter((row) => ['scripted', 'claude', 'codex', 'omp'].includes(row.engine))
      .map((row) => ({ engine: row.engine, status: row.status })),
  },
};
fs.writeFileSync(`${process.env.PUI_WORK}/${process.env.PUI_NAME}.acceptance.json`, JSON.stringify(publicReport, null, 2) + '\n');
fs.writeFileSync(`${process.env.PUI_WORK}/SHA256SUMS`, `${process.env.PUI_DIGEST}  ${process.env.PUI_NAME}\n`);
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  version: provenance.version,
  target: provenance.target,
  sourceSha: provenance.source.commit,
  archiveSha256: process.env.PUI_DIGEST,
}) + '\n');
NODE
ACCEPTANCE="$WORK/$NAME.acceptance.json"
SUMS="$WORK/SHA256SUMS"

RELEASE_HOST_ENV="${PUI_RELEASE_HOST_ENV:-$HOME/.papercusp/release-host.env}"
[[ -f "$RELEASE_HOST_ENV" ]] || die "$RELEASE_HOST_ENV not found — no release host configured"
set -a; . "$RELEASE_HOST_ENV"; set +a
BASE="${PAPERCUSP_UPDATE_BASE_URL:-${PAPERCUSP_RELEASE_HOST:-}}"
[[ -n "$BASE" ]] || die "release-host env has neither PAPERCUSP_UPDATE_BASE_URL nor PAPERCUSP_RELEASE_HOST"
BASE="${BASE%/}"
PUI_BASE_CHECK="$BASE" node <<'NODE'
const base = new URL(process.env.PUI_BASE_CHECK);
if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
  || !/^\/[A-Za-z0-9._~/-]+$/.test(base.pathname)) throw new Error('invalid release-host URL');
NODE
KEY_PREFIX="$(printf '%s' "$BASE" | sed -E 's#^https?://[^/]+/?##; s#/$##')"
[[ -n "$KEY_PREFIX" ]] || die "release host must include its permanent path prefix"
PUI_BASE="$BASE/pui"
VERSION_BASE="$PUI_BASE/$VERSION"

PUI_META="$WORK/validated.json" PUI_BASE="$PUI_BASE" PUI_VERSION_BASE="$VERSION_BASE" \
PUI_ARCHIVE_NAME="$NAME" PUI_ACCEPTANCE_NAME="$(basename "$ACCEPTANCE")" \
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const work = path.dirname(process.env.PUI_META);
const meta = JSON.parse(fs.readFileSync(process.env.PUI_META, 'utf8'));
const archiveUrl = `${process.env.PUI_VERSION_BASE}/${process.env.PUI_ARCHIVE_NAME}`;
const acceptanceUrl = `${process.env.PUI_VERSION_BASE}/${process.env.PUI_ACCEPTANCE_NAME}`;
const sumsUrl = `${process.env.PUI_VERSION_BASE}/SHA256SUMS`;
const latest = { ...meta, archiveUrl, acceptanceUrl, sumsUrl, unsigned: true };
fs.writeFileSync(path.join(work, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
fs.writeFileSync(path.join(work, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download PUI ${esc(meta.version)}</title><meta name="robots" content="noindex"><style>
body{font:16px/1.55 system-ui,sans-serif;max-width:48rem;margin:4rem auto;padding:0 1.25rem;color:#e8eef8;background:#07101d}a{color:#72c7ff}code{overflow-wrap:anywhere}.card{padding:1.25rem;border:1px solid #29415f;border-radius:.75rem;background:#0d1a2a}
</style></head><body><main><h1>PUI ${esc(meta.version)}</h1><div class="card"><p>Papercusp's terminal app for ${esc(meta.target)}.</p>
<p><a href="${esc(archiveUrl)}">Download ${esc(process.env.PUI_ARCHIVE_NAME)}</a></p>
<p>SHA-256: <code>${esc(meta.archiveSha256)}</code></p>
<p><a href="${esc(sumsUrl)}">SHA256SUMS</a> · <a href="${esc(acceptanceUrl)}">acceptance report</a></p></div>
<p>Install: unpack the archive, enter its directory, and run <code>./install.sh</code>.</p>
<p>This candidate is unsigned. Verify its SHA-256 before installing. PUI includes psu and a private Node runtime. It needs a Papercusp Server or cloud workspace; the desktop GUI is optional.</p></main></body></html>\n`);
NODE

HOSTNAME_ONLY="$(printf '%s' "$BASE" | sed -E 's#^https?://([^/]+).*#\1#')"
echo "==> release host : https://${HOSTNAME_ONLY}/<secret>/pui/"
echo "==> archive      : $NAME"
echo "==> version      : $VERSION"
echo "==> target       : $TARGET"
echo "==> sha256       : $DIGEST"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1 — validation passed; rendered files are in $WORK; nothing uploaded."
  exit 0
fi

for tool in aws curl cmp; do command -v "$tool" >/dev/null || die "missing required tool: $tool"; done
R2_ENV="${PUI_R2_ENV:-$HOME/.papercusp/r2.env}"
[[ -f "$R2_ENV" ]] || die "$R2_ENV not found — R2 credentials are not configured"
set -a; . "$R2_ENV"; set +a
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID in $R2_ENV}"
: "${R2_BUCKET:?set R2_BUCKET in $R2_ENV}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID in $R2_ENV}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY in $R2_ENV}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"

s3() {
  aws s3 --endpoint-url "$ENDPOINT" "$@" >"$WORK/storage-output.log" 2>"$WORK/storage-error.log" \
    || die "storage write failed (details retained in work directory)"
}
remote_sha() {
  local value
  if value="$(aws s3api head-object --endpoint-url "$ENDPOINT" --bucket "$R2_BUCKET" --key "$1" \
    --query 'Metadata.sha256' --output text 2>"$WORK/head-error.log")"; then
    printf '%s\n' "${value:-metadata-missing}"
  elif rg -q '\(404\)|\(NoSuchKey\)|\(NotFound\)' "$WORK/head-error.log"; then
    printf 'absent\n'
  else
    die "remote object lookup failed; absence was not established"
  fi
}
preflight_versioned() {
  local file="$1" key="$2" existing sha
  sha="$(sha256sum "$file" | cut -d' ' -f1)"
  existing="$(remote_sha "$key")"
  [[ "$existing" == absent || "$existing" == "$sha" ]] && return 0
  if [[ "$existing" == None || "$existing" == metadata-missing ]]; then
    aws s3api get-object --endpoint-url "$ENDPOINT" --bucket "$R2_BUCKET" --key "$key" \
      "$WORK/remote-object" >"$WORK/get-output.log" 2>"$WORK/get-error.log" \
      || die "could not verify an existing object without digest metadata"
    cmp -s "$file" "$WORK/remote-object" && return 0
  fi
  die "refusing to replace different bytes at immutable key ${key##*/}"
}
upload_versioned() {
  local file="$1" key="$2" type="$3" sha existing
  sha="$(sha256sum "$file" | cut -d' ' -f1)"
  existing="$(remote_sha "$key")"
  preflight_versioned "$file" "$key"
  if [[ "$existing" == "$sha" ]]; then
    echo "==> already uploaded and content-bound: ${key##*/}"
    return
  fi
  s3 cp "$file" "s3://${R2_BUCKET}/${key}" --only-show-errors --content-type "$type" \
    --cache-control 'public, max-age=31536000, immutable' --metadata "sha256=$sha"
}

VERSION_PREFIX="$KEY_PREFIX/pui/$VERSION"
preflight_versioned "$ARCHIVE" "$VERSION_PREFIX/$NAME"
preflight_versioned "$ACCEPTANCE" "$VERSION_PREFIX/$(basename "$ACCEPTANCE")"
preflight_versioned "$SUMS" "$VERSION_PREFIX/SHA256SUMS"
upload_versioned "$ARCHIVE" "$VERSION_PREFIX/$NAME" 'application/gzip'
upload_versioned "$ACCEPTANCE" "$VERSION_PREFIX/$(basename "$ACCEPTANCE")" 'application/json'
upload_versioned "$SUMS" "$VERSION_PREFIX/SHA256SUMS" 'text/plain; charset=utf-8'
for pair in "$ARCHIVE|$VERSION_PREFIX/$NAME" "$ACCEPTANCE|$VERSION_PREFIX/$(basename "$ACCEPTANCE")" "$SUMS|$VERSION_PREFIX/SHA256SUMS"; do
  file="${pair%%|*}"; key="${pair#*|}"; expected="$(sha256sum "$file" | cut -d' ' -f1)"
  [[ "$(remote_sha "$key")" == "$expected" ]] || die "R2 metadata did not bind ${key##*/} to its local SHA-256"
done

VERIFY="$WORK/public-verify"
mkdir -p "$VERIFY"
curl_public() {
  curl -A 'curl/8.0' -fsSL --max-time 120 "$1" -o "$2" 2>"$WORK/public-error.log" \
    || die "public read failed (details retained in work directory)"
}
curl_public "$VERSION_BASE/$NAME" "$VERIFY/$NAME"
curl_public "$VERSION_BASE/$(basename "$ACCEPTANCE")" "$VERIFY/$(basename "$ACCEPTANCE")"
curl_public "$VERSION_BASE/SHA256SUMS" "$VERIFY/SHA256SUMS"
[[ "$(sha256sum "$VERIFY/$NAME" | cut -d' ' -f1)" == "$DIGEST" ]] || die "public archive bytes do not match"
cmp -s "$ACCEPTANCE" "$VERIFY/$(basename "$ACCEPTANCE")" || die "public acceptance report differs"
cmp -s "$SUMS" "$VERIFY/SHA256SUMS" || die "public SHA256SUMS differs"
# Advertise only after verifying every versioned file through its public path.
s3 cp "$WORK/latest.json" "s3://${R2_BUCKET}/${KEY_PREFIX}/pui/latest.json" --only-show-errors \
  --content-type 'application/json' --cache-control 'no-cache, max-age=0'
s3 cp "$WORK/index.html" "s3://${R2_BUCKET}/${KEY_PREFIX}/pui/index.html" --only-show-errors \
  --content-type 'text/html; charset=utf-8' --cache-control 'no-cache, max-age=0'
curl_public "$PUI_BASE/latest.json?v=$DIGEST" "$VERIFY/latest.json"
curl_public "$PUI_BASE/index.html?v=$DIGEST" "$VERIFY/index.html"
cmp -s "$WORK/latest.json" "$VERIFY/latest.json" || die "public latest.json differs"
cmp -s "$WORK/index.html" "$VERIFY/index.html" || die "public index.html differs"

if [[ "${PUI_SKIP_PORTAL_CONFIG:-0}" != "1" ]]; then
  PORTAL_LINKS_ENV="${PUI_PORTAL_LINKS_ENV:-$HOME/.config/papercusp/portal-public-links.env}"
  mkdir -p "$(dirname "$PORTAL_LINKS_ENV")"
  PORTAL_LINKS_TMP="$(mktemp "$(dirname "$PORTAL_LINKS_ENV")/.portal-public-links.XXXXXX")"
  umask 077
  printf 'NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL=%s\nNEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL=%s\n' \
    "$PUI_BASE/index.html" "$BASE/index.html" > "$PORTAL_LINKS_TMP"
  chmod 0600 "$PORTAL_LINKS_TMP"
  mv -f "$PORTAL_LINKS_TMP" "$PORTAL_LINKS_ENV"
  echo "==> Portal public-link config updated (URLs masked in output)"
fi

echo "✓ PUI $VERSION published and re-downloaded byte-identically"
