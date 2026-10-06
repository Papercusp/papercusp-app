#!/usr/bin/env bash
# Build the minimal headless P2P witness and its deterministic identity manifest.
# The witness reuses the canonical serve.ts host graph but omits the Vite SPA and
# desktop shell. Optional model/capability packs are copied and hashed separately.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${PAPERCUSP_REPO_ROOT:-$(cd "$HERE/.." && pwd)}"
OUT="${PAPERCUSP_WITNESS_OUT:-$ROOT/papercusp-desktop/artifacts/p2p-witness}"
MODEL_PACK="${PAPERCUSP_WITNESS_MODEL_PACK:-}"
CAPABILITY_PACK="${PAPERCUSP_WITNESS_CAPABILITY_PACK:-}"

[[ -d "$ROOT/apps/operator" ]] || { echo "ERROR: repository root has no apps/operator: $ROOT" >&2; exit 2; }
[[ ! -e "$OUT" || "${PAPERCUSP_WITNESS_REPLACE:-0}" == "1" ]] || {
  echo "ERROR: witness output already exists; set PAPERCUSP_WITNESS_REPLACE=1 to replace it" >&2
  exit 2
}

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/papercusp-p2p-witness.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
mkdir -p "$STAGE/packs"

source "$ROOT/apps/operator/bin/bundle-host-common.sh"
HOST_EXTERNALS=(
  "${HOST_COMMON_EXTERNALS[@]}"
  --external:@embedded-postgres/darwin-arm64
  --external:@embedded-postgres/darwin-x64
  --external:@embedded-postgres/linux-arm
  --external:@embedded-postgres/linux-arm64
  --external:@embedded-postgres/linux-ia32
  --external:@embedded-postgres/linux-ppc64
  --external:@embedded-postgres/windows-x64
  --external:@papercusp/embedded-postgres-server
)
for native_package in "${NATIVE_PKGS[@]}"; do HOST_EXTERNALS+=("--external:$native_package"); done

echo "→ bundling headless P2P witness"
(cd "$ROOT/apps/operator" && npx --yes esbuild@0.25.0 bin/serve.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --minify-whitespace --minify-syntax \
  --outfile="$STAGE/serve.mjs" \
  --banner:js="$HOST_BANNER" \
  "${HOST_BANNER_DEFINES[@]}" \
  --define:__PAPERCUSP_BUNDLED_SIDECAR__=true \
  "${HOST_EXTERNALS[@]}")

if [[ -n "$MODEL_PACK" ]]; then
  [[ -e "$MODEL_PACK" ]] || { echo "ERROR: model pack does not exist: $MODEL_PACK" >&2; exit 2; }
  cp -a "$MODEL_PACK" "$STAGE/packs/model"
fi
if [[ -n "$CAPABILITY_PACK" ]]; then
  [[ -e "$CAPABILITY_PACK" ]] || { echo "ERROR: capability pack does not exist: $CAPABILITY_PACK" >&2; exit 2; }
  cp -a "$CAPABILITY_PACK" "$STAGE/packs/capability"
fi

SOURCE_SHA="$(git -C "$ROOT" rev-parse HEAD)"
SUBMODULE_SHA="$(git -C "$ROOT/libs/papercusp" rev-parse HEAD)"
node "$ROOT/scripts/p2p-witness-manifest.mjs" \
  --repo-root "$ROOT" --output-dir "$STAGE" \
  --source-sha "$SOURCE_SHA" --submodule-sha "$SUBMODULE_SHA" \
  ${MODEL_PACK:+--model-pack "$STAGE/packs/model"} \
  ${CAPABILITY_PACK:+--capability-pack "$STAGE/packs/capability"}

mkdir -p "$(dirname "$OUT")"
if [[ -e "$OUT" ]]; then rm -rf "$OUT"; fi
mv "$STAGE" "$OUT"
trap - EXIT
echo "P2P witness ready: $OUT"
