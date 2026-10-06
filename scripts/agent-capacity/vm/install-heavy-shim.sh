#!/usr/bin/env bash
# Install / remove the P-529 heavy-job admission shim (heavy-shim.sh) in a prepared checkout.
#
#   bash scripts/agent-capacity/vm/install-heavy-shim.sh <repo-root>              # install
#   bash scripts/agent-capacity/vm/install-heavy-shim.sh <repo-root> --uninstall  # restore
#
# For each of vitest, tsc, tsgo present in <repo-root>/node_modules/.bin, the original entry
# (normally a relative symlink) is renamed to .<name>.heavy-real in the same directory, so its
# relative target still resolves, and heavy-shim.sh is copied in under the original name.
# Idempotent: an entry that already carries the PC_HEAVY_SHIM_V1 marker is refreshed, not renamed
# again. With an overlay workdir (load-driver --workdir overlay), install into the LOWER
# (~/.cache/agent-capacity/prepared/<repo>) before the run; every session's merged view sees it.
# Lines to grep: HEAVY_SHIM_INSTALLED / HEAVY_SHIM_REMOVED / HEAVY_SHIM_SKIPPED.
set -euo pipefail
ROOT=${1:?usage: install-heavy-shim.sh <repo-root> [--uninstall]}
MODE=${2:-install}
SHIM="$(cd "$(dirname "$0")" && pwd)/heavy-shim.sh"
BIN="$ROOT/node_modules/.bin"
[ -d "$BIN" ] || { echo "install-heavy-shim: $BIN is not a directory" >&2; exit 2; }
[ -f "$SHIM" ] || { echo "install-heavy-shim: $SHIM missing" >&2; exit 2; }

is_shim() { [ -f "$1" ] && [ ! -L "$1" ] && grep -q PC_HEAVY_SHIM_V1 "$1" 2>/dev/null; }

for name in vitest tsc tsgo; do
  entry="$BIN/$name"
  real="$BIN/.$name.heavy-real"
  case "$MODE" in
    install)
      if is_shim "$entry"; then
        [ -e "$real" ] || { echo "install-heavy-shim: $entry is a shim but $real is missing" >&2; exit 3; }
      elif [ -e "$entry" ] || [ -L "$entry" ]; then
        mv "$entry" "$real"
      else
        echo "HEAVY_SHIM_SKIPPED name=$name reason=absent"
        continue
      fi
      cp "$SHIM" "$entry.tmp.$$"
      chmod 0755 "$entry.tmp.$$"
      mv -f "$entry.tmp.$$" "$entry"
      echo "HEAVY_SHIM_INSTALLED name=$name real=$(readlink "$real" 2>/dev/null || echo "$real")"
      ;;
    --uninstall)
      if [ -e "$real" ] || [ -L "$real" ]; then
        if [ -e "$entry" ] && ! is_shim "$entry"; then
          echo "install-heavy-shim: $entry is not a shim; leaving both in place" >&2
          exit 3
        fi
        mv -f "$real" "$entry"
        echo "HEAVY_SHIM_REMOVED name=$name"
      else
        echo "HEAVY_SHIM_SKIPPED name=$name reason=not-installed"
      fi
      ;;
    *)
      echo "install-heavy-shim: unknown mode $MODE" >&2
      exit 2
      ;;
  esac
done
