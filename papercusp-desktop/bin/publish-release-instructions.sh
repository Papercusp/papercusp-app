#!/usr/bin/env bash
#
# publish-release-instructions.sh — publish the release page's Instructions on
# their own, with no release cut and no site regenerate.
#
#   Usage:  bin/publish-release-instructions.sh
#           DRY_RUN=1 bin/publish-release-instructions.sh    # render + gate, upload nothing
#
# [owner 2026-09-28, #868] "the instructions should come seperate from the release cut".
# The release index used to embed the instructions text, so every release re-rendered
# it from whichever checkout cut that release — and the 0.0.24 publish, generated from a
# checkout pinned before that day's edits, rolled the live instructions back
# (EI-24562046738478155). Now the text lives ONLY in <secret>/instructions.html, which
# the index loads at view time. This script is the only thing that writes or uploads
# that file; record-release-cli and publish-release-history.sh never touch it.
#
# It renders from THIS checkout's apps/operator/lib/release/release-instructions.ts,
# so run it from the tree you edited the instructions in.
#
# Same rails as publish-release-history.sh: the identity gate runs on the finished bytes
# before anything is uploaded, the secret path is never printed, and the public copy is
# fetched back and compared byte-for-byte.
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"

HERE="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_ROOT="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_ROOT/.." && pwd)"
SOURCE_REL="apps/operator/lib/release/release-instructions.ts"
PAGE="instructions.html"

OUT_DIR="$(mktemp -d)"
TMP_SERVED="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR" "$TMP_SERVED"' EXIT

# ── Render ───────────────────────────────────────────────────────────────────
echo "==> rendering $PAGE from $REPO_ROOT/$SOURCE_REL"
if SRC_COMMIT="$(git -C "$REPO_ROOT" log -1 --format='%h %cI' -- "$SOURCE_REL" 2>/dev/null)" && [[ -n "$SRC_COMMIT" ]]; then
  echo "    last commit touching it: $SRC_COMMIT"
fi
if ! git -C "$REPO_ROOT" diff --quiet -- "$SOURCE_REL" 2>/dev/null; then
  echo "    (includes uncommitted edits in this checkout)"
fi
npx tsx "${REPO_ROOT}/apps/operator/lib/release/release-instructions-cli.ts" --out "$OUT_DIR"
if [[ ! -s "$OUT_DIR/$PAGE" ]]; then
  echo "ERROR: the renderer did not produce $OUT_DIR/$PAGE" >&2
  exit 1
fi

# ── Where it goes: the same secret path as the index that loads it ──────────
RELEASE_HOST_ENV="${HOME}/.papercusp/release-host.env"
if [[ ! -f "$RELEASE_HOST_ENV" ]]; then
  echo "ERROR: $RELEASE_HOST_ENV not found — no release host configured." >&2
  exit 1
fi
# shellcheck source=/dev/null
set -a; . "$RELEASE_HOST_ENV"; set +a
BASE="${PAPERCUSP_UPDATE_BASE_URL:-${PAPERCUSP_RELEASE_HOST:-}}"
if [[ -z "$BASE" ]]; then
  echo "ERROR: neither PAPERCUSP_UPDATE_BASE_URL nor PAPERCUSP_RELEASE_HOST set in $RELEASE_HOST_ENV" >&2
  exit 1
fi
KEY_PREFIX="$(printf '%s' "$BASE" | sed -E 's#^https?://[^/]+/?##; s#/$##')"
if [[ -z "$KEY_PREFIX" ]]; then
  echo "ERROR: base URL has no path segment — the secret must live in the PATH (D-002)." >&2
  exit 1
fi

# ── THE GATE — before anything is uploaded ───────────────────────────────────
# 1 = found identity, 2 = could not check. Both refuse; they mean different fixes.
echo "==> identity gate: scanning the finished bytes"
set +e
npx tsx "${REPO_ROOT}/apps/operator/lib/release/gate-release-site.ts" "$OUT_DIR"
_gate_rc=$?
set -e
if [[ $_gate_rc -eq 2 ]]; then
  echo "⛔ REFUSING TO UPLOAD — the gate COULD NOT CHECK (no owner-name literal resolved)." >&2
  echo "   Put PAPERCUSP_RELEASE_OWNER_NAME=<the owner's name> in ~/.papercusp/release-identity.env." >&2
  exit 2
elif [[ $_gate_rc -ne 0 ]]; then
  echo "⛔ REFUSING TO UPLOAD — this box's identity is present in $PAGE." >&2
  echo "   Fix $SOURCE_REL (or the scrub), then re-run." >&2
  exit 1
fi

echo
echo "==> release host : ${BASE%/*}/<secret>"
echo "==> object       : <secret>/$PAGE ($(wc -c < "$OUT_DIR/$PAGE" | tr -d ' ') bytes)"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN=1 — gate passed, nothing uploaded."
  exit 0
fi

# ── Credentials + upload ─────────────────────────────────────────────────────
R2_ENV="${HOME}/.papercusp/r2.env"
if [[ ! -f "$R2_ENV" ]]; then
  echo "ERROR: $R2_ENV not found — R2 credentials are owner-provisioned." >&2
  exit 1
fi
# shellcheck source=/dev/null
set -a; . "$R2_ENV"; set +a
: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID in $R2_ENV}"
: "${R2_BUCKET:?set R2_BUCKET in $R2_ENV}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID in $R2_ENV}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY in $R2_ENV}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
command -v aws >/dev/null 2>&1 || { echo "ERROR: aws CLI not on PATH." >&2; exit 1; }
# R2 rejects the trailing-checksum headers newer aws-cli v2 sends by default.
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"

echo "==> uploading $PAGE"
aws s3 cp "$OUT_DIR/$PAGE" "s3://${R2_BUCKET}/${KEY_PREFIX}/$PAGE" \
  --endpoint-url "$ENDPOINT" \
  --content-type 'text/html; charset=utf-8' \
  --cache-control 'no-cache, max-age=0' --only-show-errors

# ── Verify what the public path actually serves ──────────────────────────────
echo
echo "==> verifying the public read path"
HTTP_CODE="$(curl -sS -o "$TMP_SERVED/$PAGE" -w '%{http_code}' --max-time 30 "${BASE}/$PAGE" 2>/dev/null)" || true
if [[ -z "$HTTP_CODE" || "$HTTP_CODE" == "000" ]]; then
  echo "  ⚠ the release host is not reachable — $PAGE IS uploaded, but nobody can load it yet." >&2
  exit 2
fi
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "  ✗ GET $PAGE returned HTTP $HTTP_CODE" >&2
  exit 1
fi
if ! cmp -s "$OUT_DIR/$PAGE" "$TMP_SERVED/$PAGE"; then
  echo "  ✗ the served $PAGE does NOT match what we uploaded" >&2
  exit 1
fi
echo "  ✓ $PAGE served and byte-identical"
if ! npx tsx "${REPO_ROOT}/apps/operator/lib/release/gate-release-site.ts" "$TMP_SERVED"; then
  echo "  ✗ the SERVED $PAGE contains identity — it is live. Take it down NOW." >&2
  exit 1
fi

echo
echo "==> done — the Instructions are LIVE. The release page shows them on its next load."
