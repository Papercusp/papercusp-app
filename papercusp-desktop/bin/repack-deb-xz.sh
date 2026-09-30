#!/usr/bin/env bash
# Recompress a Tauri-produced Debian package's data archive with xz -9.
#
# dpkg packages are ar archives whose member order is significant.  Tauri
# currently emits data.tar.gz; rebuilding the package tree with dpkg-deb would
# also rewrite control metadata, so this helper changes only the data member.
# The replacement is assembled beside the input and atomically renamed over it.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEB_PATH="${1:?usage: repack-deb-xz.sh <package.deb>}"
[[ -f "$DEB_PATH" ]] || { echo "FATAL: deb not found: $DEB_PATH" >&2; exit 2; }

for tool in ar xz gzip dpkg-deb; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: required tool not found: $tool" >&2; exit 3; }
done

# `-T0` scales compression workers to every host core. On the release host that
# let one repack grow past 27 GiB private RSS and amplify system-wide reclaim
# pressure. Keep the release path parallel, but make its default resource cost
# independent of host size. Operators may tune either budget explicitly; xz
# automatically lowers its effective worker count if the memory cap requires it.
XZ_THREADS="${PAPERCUSP_XZ_THREADS:-4}"
XZ_MEMORY_LIMIT="${PAPERCUSP_XZ_MEMORY_LIMIT:-4GiB}"
[[ "$XZ_THREADS" =~ ^[1-9][0-9]*$ ]] || {
  echo "FATAL: PAPERCUSP_XZ_THREADS must be a positive integer, got: $XZ_THREADS" >&2
  exit 7
}
[[ "$XZ_MEMORY_LIMIT" =~ ^[1-9][0-9]*(KiB|MiB|GiB)$ ]] || {
  echo "FATAL: PAPERCUSP_XZ_MEMORY_LIMIT must be a non-zero KiB/MiB/GiB value, got: $XZ_MEMORY_LIMIT" >&2
  exit 7
}

# EI-20559353000427453: stage-source-tree.sh's identity scrub uses an external
# quarantine, so a Debian payload must never contain the old in-sidecar
# `.stage-scrub-*/` tree. Check the package before recompression (and also when
# it is already xz-packed) so a future regression fails at the Debian chokepoint
# instead of shipping duplicate redacted source files.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-deb-xz-guard.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

set +e
dpkg-deb --contents "$DEB_PATH" | grep -E '(^|/)\.stage-scrub-[^/]*/' > "$WORK/stage-scrub-members.txt"
_stage_scrub_status=("${PIPESTATUS[@]}")
set -e
if [[ "${_stage_scrub_status[0]}" != "0" ]]; then
  echo "FATAL: could not inspect Debian payload for stale .stage-scrub members: $DEB_PATH" >&2
  exit 8
fi
if [[ -s "$WORK/stage-scrub-members.txt" ]]; then
  echo "FATAL: Debian payload contains stale .stage-scrub members; refusing to ship duplicate scrub files: $DEB_PATH" >&2
  sed -n '1,20p' "$WORK/stage-scrub-members.txt" >&2
  exit 8
fi

mapfile -t MEMBERS < <(ar t "$DEB_PATH")
[[ "${#MEMBERS[@]}" -eq 3 ]] || {
  echo "FATAL: expected exactly 3 deb members in $DEB_PATH, found ${#MEMBERS[@]}" >&2
  exit 4
}
[[ "${MEMBERS[0]}" == "debian-binary" ]] || { echo "FATAL: first deb member is not debian-binary" >&2; exit 4; }
[[ "${MEMBERS[1]}" == control.tar.* ]] || { echo "FATAL: second deb member is not control.tar.*" >&2; exit 4; }
[[ "${MEMBERS[2]}" == data.tar.* ]] || { echo "FATAL: third deb member is not data.tar.*" >&2; exit 4; }

if [[ "${MEMBERS[2]}" == "data.tar.xz" ]]; then
  dpkg-deb --info "$DEB_PATH" >/dev/null
  dpkg-deb --contents "$DEB_PATH" >/dev/null
  echo "==> already xz-packed: $DEB_PATH"
  exit 0
fi

case "${MEMBERS[2]}" in
  data.tar.gz)  DECOMPRESS=(gzip -dc) ;;
  data.tar.zst) DECOMPRESS=(zstd -dc) ;;
  data.tar.bz2) DECOMPRESS=(bzip2 -dc) ;;
  data.tar)     DECOMPRESS=(cat) ;;
  *) echo "FATAL: unsupported data member ${MEMBERS[2]} in $DEB_PATH" >&2; exit 4 ;;
esac
command -v "${DECOMPRESS[0]}" >/dev/null 2>&1 || {
  echo "FATAL: decompressor not found for ${MEMBERS[2]}: ${DECOMPRESS[0]}" >&2
  exit 3
}

# Never invalidate a Tauri updater signature without being able to replace it.
if [[ -f "$DEB_PATH.sig" && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "FATAL: $DEB_PATH.sig exists but TAURI_SIGNING_PRIVATE_KEY is unset; refusing to create a stale signature" >&2
  exit 5
fi

ar p "$DEB_PATH" debian-binary > "$WORK/debian-binary"
ar p "$DEB_PATH" "${MEMBERS[1]}" > "$WORK/${MEMBERS[1]}"

# A pipefail exit alone identifies none of the four components. That made a
# real release build terminate with status 1 immediately after Tauri emitted
# its bundle, with no repack diagnostic and no way to distinguish ar,
# decompression, dedupe, or xz (EI-21564012530779610). Capture PIPESTATUS
# immediately and name every component on failure. The original deb remains
# untouched because publication is still the atomic mv below.
set +e
ar p "$DEB_PATH" "${MEMBERS[2]}" \
  | "${DECOMPRESS[@]}" \
  | python3 "$SCRIPT_DIR/dedupe-env-sidecar-tar.py" \
  | xz -9 "-T${XZ_THREADS}" "--memlimit-compress=${XZ_MEMORY_LIMIT}" -c > "$WORK/data.tar.xz"
REPACK_PIPESTATUS=("${PIPESTATUS[@]}")
set -e
if (( REPACK_PIPESTATUS[0] != 0 || REPACK_PIPESTATUS[1] != 0 || REPACK_PIPESTATUS[2] != 0 || REPACK_PIPESTATUS[3] != 0 )); then
  echo "FATAL: Debian data repack pipeline failed for $DEB_PATH" >&2
  echo "       component statuses: ar=${REPACK_PIPESTATUS[0]} decompress(${DECOMPRESS[0]})=${REPACK_PIPESTATUS[1]} dedupe-python=${REPACK_PIPESTATUS[2]} xz=${REPACK_PIPESTATUS[3]}" >&2
  exit 9
fi

REPLACEMENT="$WORK/repacked.deb"
(cd "$WORK" && ar rc "$REPLACEMENT" debian-binary "${MEMBERS[1]}" data.tar.xz)
chmod --reference="$DEB_PATH" "$REPLACEMENT"

# Exercise both metadata and payload readers before replacing the known-good deb.
dpkg-deb --info "$REPLACEMENT" >/dev/null
dpkg-deb --contents "$REPLACEMENT" >/dev/null

SIGNATURE_STATUS="UNSIGNED"
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  # WI-3823 (again, here): `tauri signer sign` accepts ONLY the key CONTENT (base64)
  # in TAURI_SIGNING_PRIVATE_KEY, while `tauri build` accepts contents OR a path — so
  # the conventional callers legitimately export a PATH (build-linux-local.sh:98 and
  # build-and-archive-deb.sh:63 both do, unconditionally) and only THIS call site
  # breaks. Symptom when unresolved, after a full compile + multi-GB bundle:
  #   failed to decode base64 secret key: ... Invalid symbol 45, offset 11
  # (symbol 45 is '-', and the offset lands on the first '-' of the key's own
  # pathname — i.e. the decoder was handed the path itself, not a key). The offset
  # therefore varies by machine; the "Invalid symbol 45" is the stable signature.
  # Resolve a path to its contents and hand the
  # secret over via the CLI's own env fallback, never on argv: `npm run`/npx echo the
  # resolved command line, which would print the private key into the build log and
  # expose it in `ps` for the life of the process.
  _key="$TAURI_SIGNING_PRIVATE_KEY"; [[ -f "$_key" ]] && _key="$(cat "$_key")"
  TAURI_SIGNING_PRIVATE_KEY="$_key" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
    npx --yes -p "@tauri-apps/cli@${PAPERCUSP_TAURI_CLI_VERSION:-2.11.0}" \
      tauri signer sign "$REPLACEMENT" >/dev/null
  [[ -s "$REPLACEMENT.sig" ]] || { echo "FATAL: Tauri signer produced no signature for the replacement package" >&2; exit 6; }
  SIGNATURE_STATUS="signed"
fi

# Publish only after every validation AND signing step succeeds. A signer
# failure must leave the known-good deb and its matching signature untouched.
mv -f "$REPLACEMENT" "$DEB_PATH"
if [[ "$SIGNATURE_STATUS" == "signed" ]]; then
  mv -f "$REPLACEMENT.sig" "$DEB_PATH.sig"
fi

echo "✓ repacked data member as xz -9: $DEB_PATH ($SIGNATURE_STATUS)"
if [[ "$SIGNATURE_STATUS" == "UNSIGNED" ]]; then
  echo "⚠ UNSIGNED: no TAURI_SIGNING_PRIVATE_KEY supplied; $DEB_PATH has no .sig" >&2
fi
