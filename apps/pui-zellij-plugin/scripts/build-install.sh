#!/usr/bin/env bash
# Compatibility entry point. P-021 makes the native binary + companion WASM one
# install generation, so a plugin-only install is no longer supported.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/../../tui/scripts/install-update.sh" "$@"
