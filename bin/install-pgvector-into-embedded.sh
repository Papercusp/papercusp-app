#!/usr/bin/env bash
#
# install-pgvector-into-embedded.sh [embedded-postgres-native-dir]
#
# Copy a system-installed pgvector (Postgres 18 build) into the
# @embedded-postgres/linux-x64 binary tree so embedded-pg can load the
# extension. Required because the @embedded-postgres distribution
# ships postgres but NOT pgvector.
#
# Prerequisites on the host:
#   sudo apt install postgresql-18-pgvector
#
# Argument (optional): path to the `native/` dir of the target
# embedded-postgres install — e.g.
#   /path/to/checkout/node_modules/@embedded-postgres/linux-x64/native
# When omitted, defaults to this script's repo root.
# (E2E round-13 bug #29: an alternate-worktree caller passing an arg
# was silently ignored and the script overwrote the WRONG node_modules.)
#
# Idempotent: skips files that already exist with identical contents.
#
# Run after `pnpm install` or `npm install` whenever node_modules is
# rebuilt. Not invoked automatically (sudo-on-postinstall is too
# invasive); call manually or wire into your environment-setup script.

set -euo pipefail

# Resolve repo root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC_LIB="/usr/lib/postgresql/18/lib"
SRC_EXT="/usr/share/postgresql/18/extension"

# Detect platform-specific embedded-postgres dir.
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PLAT="linux-x64" ;;
  Linux-aarch64) PLAT="linux-arm64" ;;
  Darwin-x86_64) PLAT="darwin-x64" ;;
  Darwin-arm64) PLAT="darwin-arm64" ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

# Honor explicit target arg (the `native/` dir of an alternate
# embedded-postgres install — common when multiple worktrees share
# a parent dir). Fall back to repo-relative default.
if [[ $# -ge 1 && -n "$1" ]]; then
  DEST_BASE="$1"
else
  DEST_BASE="${REPO_ROOT}/node_modules/@embedded-postgres/${PLAT}/native"
fi
DEST_LIB="${DEST_BASE}/lib/postgresql"
DEST_EXT="${DEST_BASE}/share/postgresql/extension"

if [[ ! -d "${DEST_BASE}" ]]; then
  echo "Embedded postgres dir not found at ${DEST_BASE} — run pnpm/npm install first." >&2
  exit 1
fi

if [[ ! -f "${SRC_LIB}/vector.so" ]]; then
  echo "System pgvector not found at ${SRC_LIB}/vector.so." >&2
  echo "Install with: sudo apt install postgresql-18-pgvector" >&2
  exit 1
fi

echo "Copying pgvector into ${DEST_BASE}"
cp -u "${SRC_LIB}/vector.so" "${DEST_LIB}/"
cp -u "${SRC_EXT}"/vector*.sql "${DEST_EXT}/"
cp -u "${SRC_EXT}/vector.control" "${DEST_EXT}/"

echo "Done. Restart embedded-pg, then on next boot migration 060 will run CREATE EXTENSION vector."
