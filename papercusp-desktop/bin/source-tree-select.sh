#!/usr/bin/env bash
# source-tree-select.sh — materialize the public-safe source cut as a DIRECTORY.
# Plan dhh-source-preview-2026-09-28 (P-001, D-002/D-003).
#
# The installer ships this same cut as sidecar/source.tar.zst (bin/stage-source-tree.sh).
# This is its directory form for the private source preview repo: the SAME
# selection (bin/lib/source-tree-selection.sh), the SAME identity scrub
# (audit-release-bundle.py --source-leakers / --scrub-text), run through the SAME
# GNU tar exclude engine so the matching semantics cannot differ from the
# installer's. It does not gate — scripts/source-preview.mjs runs the gate on the
# finished directory, exactly as stage-source-tree.sh gates its finished archive.
#
# Usage:
#   bin/source-tree-select.sh --mono <tree> --into <empty-or-absent dir> [--mode preview|installer]
#
#   --mono  a monorepo tree to select from. For the preview this is a CLEAN
#           export of one pinned commit (no working-tree debris), produced by
#           scripts/source-preview.mjs.
#   --into  destination; must not exist or be empty.
#   --mode  preview (default: no node_modules) | installer.
#
# Exit: 0 selected + scrubbed · 1 refused · 2 usage / cannot check.
set -euo pipefail
{
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONO=""
INTO=""
MODE="preview"
while (( $# > 0 )); do
  case "$1" in
    --mono) MONO="${2:-}"; shift 2 ;;
    --into) INTO="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$MONO" && -n "$INTO" ]] || { echo "ERROR: --mono and --into are required" >&2; exit 2; }
[[ -d "$MONO" ]] || { echo "ERROR: --mono $MONO is not a directory" >&2; exit 2; }
MONO="$(cd "$MONO" && pwd)"
if [[ -e "$INTO" ]]; then
  [[ -d "$INTO" && -z "$(ls -A "$INTO")" ]] \
    || { echo "ERROR: --into $INTO exists and is not an empty directory" >&2; exit 2; }
fi
[[ -f "$MONO/apps/operator/package.json" && -f "$MONO/libs/papercusp/package.json" ]] \
  || { echo "ERROR: $MONO is not the monorepo root (missing apps/operator + libs/papercusp package.json markers)" >&2; exit 1; }

TAR_BIN=tar
if ! tar --version 2>/dev/null | grep -q 'GNU tar'; then
  if command -v gtar >/dev/null 2>&1; then TAR_BIN=gtar
  else echo "ERROR: GNU tar required — the shared selection uses GNU exclude semantics" >&2; exit 2
  fi
fi

# Stable compatibility entrypoint for the audit-owned identity policy. D-112 makes
# owner name/email legitimate release content; machine and credential checks remain.
python3 "$HERE/audit-release-bundle.py" --owner-preflight \
  || { echo "ERROR: identity-policy preflight failed" >&2; exit 2; }

# shellcheck source=lib/source-tree-selection.sh
. "$HERE/lib/source-tree-selection.sh"
source_tree_selection "$HERE" "$MONO" "$MODE" || exit 1
echo "==> source-tree-select: ${#SELECTION_INCLUDES[@]} top-level entries, ${#SELECTION_EXCLUDES[@]} exclude patterns (mode=$MODE)"

mkdir -p "$INTO"
set +e +o pipefail
"$TAR_BIN" --numeric-owner --owner=0 --group=0 \
  "${SELECTION_EXCLUDES[@]}" \
  -C "$MONO" -cf - "${SELECTION_INCLUDES[@]}" \
  | "$TAR_BIN" -xf - -C "$INTO"
rcs=("${PIPESTATUS[@]}")
set -e -o pipefail
(( rcs[0] == 0 )) || { echo "ERROR: tar (create) failed (exit ${rcs[0]})" >&2; exit 1; }
(( rcs[1] == 0 )) || { echo "ERROR: tar (extract) failed (exit ${rcs[1]})" >&2; exit 1; }

# Identity scrub, on the COPY (never the source tree): the audit owns both the
# leaking-file detection and the redaction rule, exactly as in the installer.
entries=()
for inc in "${SELECTION_INCLUDES[@]}"; do entries+=("${inc#./}"); done
scrubbed=0
while IFS= read -r rel; do
  [[ -n "$rel" && -f "$INTO/$rel" ]] || continue
  python3 "$HERE/audit-release-bundle.py" --scrub-text "$INTO/$rel"
  scrubbed=$((scrubbed + 1))
done < <(python3 "$HERE/audit-release-bundle.py" --source-leakers "$INTO" "${entries[@]}")
echo "    identity scrub: redacted $scrubbed file(s)"
exit 0
}
