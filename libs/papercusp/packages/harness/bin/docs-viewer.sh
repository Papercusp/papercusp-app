#!/usr/bin/env bash
#
# Starts the standalone Starlight docs viewer. Wires up one symlink per
# registered harness project: `docs-viewer/src/content/docs/projects/<slug>/`
# → `<project-path>/docs/`. Projects that don't yet have a docs/ directory
# get one scaffolded via bin/ensure-docs.sh before they're mounted.
#
# Usage:
#   bin/docs-viewer.sh               # start dev server (default port 4325)
#   bin/docs-viewer.sh --build       # build static output to ./dist
#   bin/docs-viewer.sh --port 4326   # override port
#   DOCS_PORT=4326 bin/docs-viewer.sh
#
# Registry: ~/.restart-harness-projects.json (same file the harness uses)
set -euo pipefail

HARNESS_DIR="${HARNESS_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"/.. && pwd)}"
VIEWER_DIR="$HARNESS_DIR/docs-viewer"
REGISTRY="${HARNESS_REGISTRY:-$HOME/.restart-harness-projects.json}"
PROJECTS_CONTENT="$VIEWER_DIR/src/content/docs/projects"

MODE="dev"
while [ $# -gt 0 ]; do
  case "$1" in
    --build) MODE="build"; shift ;;
    --preview) MODE="preview"; shift ;;
    --port) DOCS_PORT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
export DOCS_PORT="${DOCS_PORT:-4325}"

[ -d "$VIEWER_DIR" ] || { echo "docs-viewer dir missing: $VIEWER_DIR" >&2; exit 1; }

# Ensure deps are installed on first run.
if [ ! -d "$VIEWER_DIR/node_modules" ]; then
  echo "==> Installing docs-viewer dependencies (first run, ~60s)"
  ( cd "$VIEWER_DIR" && npm install --no-audit --no-fund --prefer-offline --legacy-peer-deps )
fi

# Rebuild the symlink farm. Removing anything stale first means dropping a
# project from the registry actually removes its sidebar section.
rm -rf "$PROJECTS_CONTENT"
mkdir -p "$PROJECTS_CONTENT"

if [ ! -f "$REGISTRY" ]; then
  echo "==> No project registry at $REGISTRY — viewer will show only the intro page."
else
  # Emit one "<slug>|<path>" line per project (pipe separator avoids the
  # tab-escape pain bash+edit-tools sometimes cause).
  readarray -t projects < <(REG="$REGISTRY" python3 -c '
import json, os, sys
try:
    r = json.load(open(os.environ["REG"]))
except Exception:
    sys.exit(0)
for p in r.get("projects", []):
    slug = p.get("slug", "").strip()
    path = p.get("path", "").strip()
    if slug and path:
        print(f"{slug}|{path}")
')
  linked=0
  for row in "${projects[@]:-}"; do
    [ -z "$row" ] && continue
    slug="${row%%|*}"
    path="${row#*|}"
    if [ -z "$slug" ] || [ -z "$path" ]; then continue; fi
    if [ ! -d "$path" ]; then
      echo "==> Skipping project '$slug' — path does not exist: $path"
      continue
    fi
    if [ -x "$HARNESS_DIR/bin/ensure-docs.sh" ]; then
      "$HARNESS_DIR/bin/ensure-docs.sh" "$path" "$slug" >/dev/null || true
    fi
    if [ ! -d "$path/docs" ]; then
      echo "==> Skipping project '$slug' — no docs/ directory at $path"
      continue
    fi
    ln -sfn "$path/docs" "$PROJECTS_CONTENT/$slug"
    echo "==> Linked project '$slug' → $path/docs"
    linked=$((linked + 1))
  done
  echo "==> $linked project doc tree(s) mounted"
fi

cd "$VIEWER_DIR"
case "$MODE" in
  dev)     exec npm run dev ;;
  build)   exec npm run build ;;
  preview) exec npm run preview ;;
esac
