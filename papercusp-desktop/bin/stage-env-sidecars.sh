#!/usr/bin/env bash
# stage-env-sidecars.sh — WI-3287; pinned contract, plan
# env-switcher-packaged-all-platforms-2026-07-06.
#
# The packaged env switcher spawns <sidecarDir>/env-sidecars/<envId>/serve.mjs,
# discovered via dirname(PAPERCUSP_SIDECAR_BIN) = the installed sidecar dir
# (env-operator-launcher.ts resolveBundledSidecar). V1 ships exactly ONE extra
# bundle: staging — cloned from the just-built primary sidecar's own payload
# (this box builds from the staging tip, so "staging" and "prod" would be
# identical code today; the bundle exists so the button + spawn path are real
# and exercised end-to-end).
#
# Must run AFTER bin/build-desktop-sidecar.sh (needs a fresh src-tauri/sidecar/)
# and BEFORE `tauri build` (so the existing `sidecar/**/*` resources glob in
# both tauri.conf.json and tauri.server.conf.json sweeps it up — zero
# tauri.conf / Rust changes needed). Staging INSIDE sidecar/ is safe here
# because this runs sequentially on one checkout with no concurrent sidecar
# rebuild — same pattern proven on mac (bin/mac-vm-build.sh). Windows instead
# stages OUTSIDE sidecar/ because its packer runs concurrently with a live
# sidecar rebuild on a shared dev-box tree (see build-windows-on-vm.sh) — not
# a concern for a single local Linux build.
#
# Sidecar-shaped per the contract: serve.mjs + spa/ + db-sql/ (+ prompts/harness
# when present). NO bin/ (the launcher reuses the primary's node), NO
# internal-docs (V1 env serves no /internal/docs), NO db-seed (the env attaches
# to the primary's embedded PG, EI-126 request-only). Hardlinked (cp -al) — same
# filesystem, ~0 extra disk; tauri copies real bytes into the bundle at pack time.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SIDECAR="$ROOT/src-tauri/sidecar"

if [[ ! -f "$SIDECAR/serve.mjs" ]]; then
  echo "ERROR: $SIDECAR/serve.mjs missing — run bin/build-desktop-sidecar.sh first" >&2
  exit 1
fi

echo "==> staging env-sidecars/staging (packaged env switcher, WI-3287)"
ENV_SC="$SIDECAR/env-sidecars/staging"
rm -rf "$SIDECAR/env-sidecars"
mkdir -p "$ENV_SC"
cp -al "$SIDECAR/serve.mjs" "$ENV_SC/serve.mjs"
cp -al "$SIDECAR/spa" "$ENV_SC/spa"
cp -al "$SIDECAR/db-sql" "$ENV_SC/db-sql"
# Carry the primary sidecar's immutable provenance beside the child bundle.
# The request-only launcher must derive its own build identity from these bytes,
# never from the primary's inherited environment. Older development sidecars
# without the file remain load-only but are reported as unverified.
if [[ -s "$SIDECAR/build-provenance.json" ]]; then
  cp -a "$SIDECAR/build-provenance.json" "$ENV_SC/build-provenance.json"
elif [[ -s "$SIDECAR/.sidecar-build-stamp" ]]; then
  cp -a "$SIDECAR/.sidecar-build-stamp" "$ENV_SC/.sidecar-build-stamp"
fi
for env_sc_extra in prompts harness; do
  if [[ -e "$SIDECAR/$env_sc_extra" ]]; then
    cp -al "$SIDECAR/$env_sc_extra" "$ENV_SC/$env_sc_extra"
  fi
done
[[ -f "$ENV_SC/serve.mjs" && -d "$ENV_SC/spa" && -d "$ENV_SC/db-sql" ]] \
  || { echo "ERROR: env-sidecars/staging incomplete (need serve.mjs + spa/ + db-sql/)" >&2; exit 1; }
echo "    ✓ env-sidecars/staging staged ($(du -sh "$ENV_SC" | cut -f1) apparent, hardlinked)"
