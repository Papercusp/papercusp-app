#!/usr/bin/env bash
# The installed-TUI release stage (pui-first-party-public-release P-012 / D-018).
#
# Installs one candidate archive from apps/tui/scripts/package-release.sh into a
# clean HOME, drives the production-operator PTY suites through that installed
# bin/pui, and writes <archive>.acceptance.json. An archive may be published
# (P-014/P-015) only with a passing acceptance file for the same digest.
#
# Exit 0 = accepted, 1 = refused (the file names every reason), 2 = could not run.
# --help prints the options.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
exec "$ROOT/node_modules/.bin/tsx" "$ROOT/packages/operator-core/lib/pui-e2e/release-acceptance-cli.mts" "$@"
