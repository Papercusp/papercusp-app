#!/usr/bin/env bash
# Reproducible build of the release inspector (not a shipped app dependency).
# Reuses the installed pinned upstream checkout and the existing compatibility
# preflight. Never edits that checkout or replaces an installed consumer.
# Usage: bash bin/build-innoextract.sh [upstream-checkout] [new-install-prefix]
set -euo pipefail
{
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REVISION=376a13e7c41cc5528b6088d0dd16ec1b323a8d37
PATCHES=(
  "$HERE/lib/innoextract-verification-metadata.patch"
  "$HERE/lib/innoextract-disk-slice-header.patch"
)
# Content/order, never absolute checkout paths, determine the immutable prefix.
PATCH_SHA="$(cat "${PATCHES[@]}" | sha256sum | cut -d' ' -f1)"
SOURCE="${1:-$HOME/.papercusp/toolchains/innoextract-$REVISION/src}"
PREFIX="${2:-$HOME/.papercusp/toolchains/innoextract-$REVISION-verification-${PATCH_SHA:0:12}}"

[[ ! -e "$PREFIX" ]] || { echo "ERROR: refusing to overwrite $PREFIX" >&2; exit 1; }
[[ "$(git -C "$SOURCE" rev-parse "$REVISION^{commit}")" == "$REVISION" ]]
mkdir -p "$(dirname "$PREFIX")"
WORK="$(mktemp -d "$(dirname "$PREFIX")/.innoextract-build.XXXXXX")"
trap 'echo "Inspector build retained at $WORK" >&2' ERR
mkdir "$WORK/src"
git -C "$SOURCE" archive "$REVISION" | tar -x -C "$WORK/src"
for PATCH in "${PATCHES[@]}"; do
  patch --batch --fuzz=0 -d "$WORK/src" -p1 < "$PATCH" >&2
done
cmake -S "$WORK/src" -B "$WORK/build" -DCMAKE_BUILD_TYPE=Release >&2
cmake --build "$WORK/build" >&2
mkdir "$WORK/bin"
cp "$WORK/build/innoextract" "$WORK/bin/innoextract"
source "$HERE/lib/innoextract-compat-preflight.sh"
innoextract_compat_preflight "$WORK/bin/innoextract" >/dev/null
python3 - "$WORK" "$REVISION" "$PATCH_SHA" "${PATCHES[@]}" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
binary = root / "bin/innoextract"
(root / "manifest.json").write_text(json.dumps({
    "sourceCommit": sys.argv[2],
    "patchSha256": sys.argv[3],
    "patches": {
        pathlib.Path(p).name: hashlib.file_digest(open(p, "rb"), "sha256").hexdigest()
        for p in sys.argv[4:]
    },
    "binarySha256": hashlib.file_digest(binary.open("rb"), "sha256").hexdigest(),
    "modifiedSource": True,
    "verification": "exact ISCC spanned fixture, byte equality, corruption and invalid-header refusal",
}, indent=2) + "\n")
PY
mv -T "$WORK" "$PREFIX"
trap - ERR
printf '%s\n' "$PREFIX/bin/innoextract"
}
