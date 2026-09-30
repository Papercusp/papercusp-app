#!/usr/bin/env bash
#
# Idempotently ensure a project has a `docs/` tree suitable for the
# harness docs-viewer (Starlight).
#
# Called from:
#   - run.sh, at harness startup (so the documenter has somewhere to write)
#   - bin/docs-viewer.sh, before symlinking (so even unrun projects mount)
#
# Usage:
#   bin/ensure-docs.sh <absolute-project-path> [project-title]
#
# Safe to call repeatedly. Never overwrites existing files.
set -euo pipefail

PROJECT_DIR="${1:-}"
TITLE="${2:-}"

if [ -z "$PROJECT_DIR" ] || [ ! -d "$PROJECT_DIR" ]; then
  echo "ensure-docs: missing or invalid project dir: $PROJECT_DIR" >&2
  exit 2
fi

# Derive a title if the caller didn't supply one.
if [ -z "$TITLE" ]; then
  if [ -f "$PROJECT_DIR/package.json" ]; then
    TITLE="$(PKG="$PROJECT_DIR/package.json" python3 -c '
import json, os, sys
try:
    name = json.load(open(os.environ["PKG"])).get("name", "")
    print(name.replace("@", "").replace("/", "-"))
except Exception:
    pass
' 2>/dev/null)"
  fi
  if [ -z "$TITLE" ]; then
    TITLE="$(basename "$PROJECT_DIR")"
  fi
fi

DOCS="$PROJECT_DIR/docs"
mkdir -p "$DOCS/features" "$DOCS/guides"

# Top-level landing page. Only written once.
if [ ! -f "$DOCS/index.md" ]; then
  cat > "$DOCS/index.md" <<EOF
---
title: $TITLE
description: Auto-generated documentation from the autonomous harness.
---

This documentation is written by the harness **documenter** role. Each row
in the table below corresponds to a feature defined in
\`.papercusp/features.json\`. When the validator marks a feature \`passed\`,
the documenter adds or refreshes its page under \`features/\`.

## Feature status

| ID | Title | Status | Page |
|----|-------|--------|------|
| *(populated by the documenter — no features have passed yet in this docs session)* | | | |

## Guides

Cross-cutting guides live under \`guides/\`. They appear in the sidebar as
the documenter produces them.
EOF
fi

# Placeholder under features/ so the sidebar renders cleanly before any
# real feature pages exist. `_`-prefixed files are excluded from Starlight's
# docsLoader glob, and `sidebar.hidden` keeps it out of nav for safety.
if [ ! -f "$DOCS/features/_placeholder.md" ]; then
  cat > "$DOCS/features/_placeholder.md" <<'EOF'
---
title: No features documented yet
description: Waiting for the first feature to pass validation.
sidebar:
  hidden: true
---

This page is a placeholder so the sidebar renders before the documenter
has written any real feature pages. It will be superseded by one page
per `F-*` feature as the harness marks features `passed`.
EOF
fi

# Same placeholder idea for guides/.
if [ ! -f "$DOCS/guides/_placeholder.md" ]; then
  cat > "$DOCS/guides/_placeholder.md" <<'EOF'
---
title: No guides yet
description: Cross-cutting guides will appear here as the documenter writes them.
sidebar:
  hidden: true
---

Placeholder. Superseded as guides get produced.
EOF
fi

# Succeed silently.
exit 0
