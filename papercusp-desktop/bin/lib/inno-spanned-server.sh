#!/usr/bin/env bash
# inno-spanned-server.sh — normalize an Inno DiskSpanning Server installer.
#
# Inno emits a small `*-setup.exe` stub plus `*-setup-N.bin` payload disks when
# the Server bundle exceeds its single-exe ceiling.  The stub is not a usable
# download by itself, and the payload disks are not updater artifacts.  Keep
# the detection and zip operation shared by every Windows release entry point;
# otherwise a direct cross-build can disagree with the full release cut or an
# incremental publisher.

PAPERCUSP_SPANNED_SERVER_STUB=""
PAPERCUSP_SPANNED_SERVER_ZIP=""
PAPERCUSP_SPANNED_SERVER_ZIP_SIG=""
PAPERCUSP_SPANNED_SERVER_SLICES=()
# Every file this normalization PRODUCES, in the order a caller should append them
# to its artifact array.  Callers use THIS instead of naming the zip directly, so a
# future additional output cannot be silently dropped by two of three call sites —
# which is exactly how the zip shipped unsigned (EI-20595279927716716).
PAPERCUSP_SPANNED_SERVER_OUTPUTS=()

# papercusp_sign_spanned_server_zip <zip> — produce <zip>.sig (Tauri/minisign).
#
# WHY THIS EXISTS: signing used to follow the UPDATER pipeline only.  `tauri build`
# signs what it bundles, so every updater input (.deb/.AppImage/-setup.exe/.app.tar.gz)
# got a sibling .sig for free — but this zip is assembled by US, after the bundler has
# run, so nothing ever signed it.  The Server zip is the single largest download the
# release page offers and it shipped with NO signature in 0.0.16 AND 0.0.17.
# Signing lives HERE, beside the zip's creation, not in the three callers: a
# caller-side signing step is the same drift class the normalization helper was
# extracted to end.
#
# BEST-EFFORT BY DESIGN: a keyless dev/CI cut still produces a valid zip — signing is
# skipped with a warning rather than failing the build.  The POLICY is enforced at
# publish time by release_artifacts_assert_signatures_present, which is where an
# unsigned download actually becomes a user-visible defect.
#
# Sets PAPERCUSP_SPANNED_SERVER_ZIP_SIG on success; leaves it empty otherwise.
papercusp_sign_spanned_server_zip() {
  local zip="$1"
  PAPERCUSP_SPANNED_SERVER_ZIP_SIG=""
  [[ -s "$zip" ]] || return 1

  # Resolve the key the same way every other signing call site does.
  local key="${TAURI_SIGNING_PRIVATE_KEY:-}"
  if [[ -z "$key" ]]; then
    local key_path="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.papercusp/signing/papercusp.key}"
    [[ -f "$key_path" ]] || {
      echo "WARNING: [win] no updater signing key (TAURI_SIGNING_PRIVATE_KEY / _PATH / ~/.papercusp/signing/papercusp.key) — leaving $(basename "$zip") UNSIGNED (EI-20595279927716716)" >&2
      return 1
    }
    key="$key_path"
  fi
  # WI-3823: `tauri signer sign` accepts ONLY the key CONTENT (base64) in
  # TAURI_SIGNING_PRIVATE_KEY, while `tauri build` accepts contents OR a path — so a
  # caller that legitimately exported a PATH breaks only at this call site, after the
  # multi-GB bundle is already built ("failed to decode base64 secret key: Invalid
  # symbol 45" — symbol 45 is the '-' in the key's own pathname).  Resolve it here.
  [[ -f "$key" ]] && key="$(cat "$key")"

  # PAPERCUSP_SIGNER_CMD=P — run `P <file>` instead of npx (test seam; also lets a
  # host with a preinstalled tauri CLI skip the npx fetch). Same contract either
  # way: exit 0 AND a non-empty <file>.sig on disk.
  local -a signer=()
  if [[ -n "${PAPERCUSP_SIGNER_CMD:-}" ]]; then
    signer=( "${PAPERCUSP_SIGNER_CMD}" )
  else
    command -v npx >/dev/null 2>&1 || {
      echo "WARNING: [win] npx unavailable — leaving $(basename "$zip") UNSIGNED (EI-20595279927716716)" >&2
      return 1
    }
    signer=( npx --yes -p "@tauri-apps/cli@${PAPERCUSP_TAURI_CLI_VERSION:-2.11.0}" tauri signer sign )
  fi

  rm -f "$zip.sig"
  # The secret goes via the CLI's own env fallback, NEVER on argv: npx echoes the
  # resolved command line, which would print the private key into the build log and
  # expose it in `ps` for the life of the process.
  # Once resolved to content, the inherited path option must disappear in this
  # child. Tauri rejects content + path even when both arrived through env.
  # A subshell keeps the caller's path intact and the secret off `env`'s argv.
  if ! ( unset TAURI_SIGNING_PRIVATE_KEY_PATH
         TAURI_SIGNING_PRIVATE_KEY="$key" \
         TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
         "${signer[@]}" "$zip" ) >/dev/null 2>&1 \
     || [[ ! -s "$zip.sig" ]]; then
    rm -f "$zip.sig"
    echo "WARNING: [win] tauri signer sign failed for $(basename "$zip") — leaving it UNSIGNED (EI-20595279927716716)" >&2
    return 1
  fi

  PAPERCUSP_SPANNED_SERVER_ZIP_SIG="$zip.sig"
  return 0
}

# papercusp_normalize_spanned_server <inno_dir> <version>
#
# Return codes:
#   0 — a Server stub + slices were found and a non-empty zip was produced.
#   1 — no spanned Server set was found (also used for a single-file Server).
#   2 — a spanned set was found but normalization failed; callers must refuse
#       to publish the raw stub/slices.
#
# The raw files remain on disk.  Callers replace them in their artifact arrays
# with PAPERCUSP_SPANNED_SERVER_ZIP, which keeps provenance/debugging intact
# while ensuring upload and manifest inputs contain one usable bundle.
papercusp_normalize_spanned_server() {
  local inno_dir="$1" version="$2" f
  PAPERCUSP_SPANNED_SERVER_STUB=""
  PAPERCUSP_SPANNED_SERVER_ZIP=""
  PAPERCUSP_SPANNED_SERVER_ZIP_SIG=""
  PAPERCUSP_SPANNED_SERVER_SLICES=()
  PAPERCUSP_SPANNED_SERVER_OUTPUTS=()

  [[ -d "$inno_dir" ]] || return 1

  local -a stubs=()
  shopt -s nullglob
  stubs=( "$inno_dir"/*Server*_"$version"_*-setup.exe )
  shopt -u nullglob
  for f in "${stubs[@]}"; do
    [[ -f "$f" ]] && PAPERCUSP_SPANNED_SERVER_STUB="$f"
  done
  [[ -n "$PAPERCUSP_SPANNED_SERVER_STUB" ]] || return 1

  local base="${PAPERCUSP_SPANNED_SERVER_STUB%.exe}"
  shopt -s nullglob
  PAPERCUSP_SPANNED_SERVER_SLICES=( "$base"-*.bin )
  shopt -u nullglob
  local -a existing_slices=()
  for f in "${PAPERCUSP_SPANNED_SERVER_SLICES[@]}"; do
    [[ -f "$f" ]] && existing_slices+=("$f")
  done
  PAPERCUSP_SPANNED_SERVER_SLICES=( "${existing_slices[@]}" )
  # A Server setup without slices is a valid single-file build, not a span.
  (( ${#PAPERCUSP_SPANNED_SERVER_SLICES[@]} > 0 )) || return 1

  PAPERCUSP_SPANNED_SERVER_ZIP="${base}.zip"
  if ! command -v zip >/dev/null 2>&1 \
     || ! rm -f "$PAPERCUSP_SPANNED_SERVER_ZIP" \
     || ! zip -0 -j "$PAPERCUSP_SPANNED_SERVER_ZIP" \
          "$PAPERCUSP_SPANNED_SERVER_STUB" \
          "${PAPERCUSP_SPANNED_SERVER_SLICES[@]}" >/dev/null 2>&1 \
     || [[ ! -s "$PAPERCUSP_SPANNED_SERVER_ZIP" ]]; then
    PAPERCUSP_SPANNED_SERVER_ZIP=""
    return 2
  fi

  # Sign the zip we just built. Best-effort: an unsigned zip is still a usable
  # download, and the publish-time guard is what refuses to ship one.
  papercusp_sign_spanned_server_zip "$PAPERCUSP_SPANNED_SERVER_ZIP" || true

  PAPERCUSP_SPANNED_SERVER_OUTPUTS=( "$PAPERCUSP_SPANNED_SERVER_ZIP" )
  [[ -n "$PAPERCUSP_SPANNED_SERVER_ZIP_SIG" ]] \
    && PAPERCUSP_SPANNED_SERVER_OUTPUTS+=( "$PAPERCUSP_SPANNED_SERVER_ZIP_SIG" )
  return 0
}

# papercusp_spanned_server_artifact <path> — true when PATH is one of the raw
# span inputs (including its orphanable signature) or a normalization OUTPUT
# (the zip, or the zip's signature).  Callers use this to strip the span from
# their artifact array before re-appending PAPERCUSP_SPANNED_SERVER_OUTPUTS, so
# every produced file must match here or a re-scan would duplicate it.
papercusp_spanned_server_artifact() {
  local artifact="$1" slice
  [[ -n "$PAPERCUSP_SPANNED_SERVER_STUB" ]] || return 1
  [[ "$artifact" == "$PAPERCUSP_SPANNED_SERVER_STUB" \
     || "$artifact" == "$PAPERCUSP_SPANNED_SERVER_STUB.sig" \
     || ( -n "$PAPERCUSP_SPANNED_SERVER_ZIP" && "$artifact" == "$PAPERCUSP_SPANNED_SERVER_ZIP" ) \
     || ( -n "$PAPERCUSP_SPANNED_SERVER_ZIP" && "$artifact" == "$PAPERCUSP_SPANNED_SERVER_ZIP.sig" ) ]] && return 0
  for slice in "${PAPERCUSP_SPANNED_SERVER_SLICES[@]}"; do
    [[ "$artifact" == "$slice" ]] && return 0
  done
  return 1
}
