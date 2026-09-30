#!/usr/bin/env bash
# setup-phases.sh — create sibling git worktrees for the 3-phase harness model.
#
# Usage: setup-phases.sh <project-path> [--phases testing,production]
#
# Given a project at /path/to/proj (on branch `main` or `master` — i.e. staging),
# creates:
#   /path/to/proj--testing       worktree on branch `testing`
#   /path/to/proj--production    worktree on branch `production`
#
# Idempotent: re-running is a no-op. Initialises each worktree's `.papercusp/`
# directory from the staging worktree (features.json etc. NOT copied — each
# phase has its own fresh queue).

set -euo pipefail

PROJECT_PATH="${1:?usage: setup-phases.sh <project-path> [--phases csv]}"
shift || true

PHASES="testing,production"
while [ $# -gt 0 ]; do
    case "$1" in
        --phases) PHASES="$2"; shift 2;;
        *) echo "unknown flag: $1" >&2; exit 1;;
    esac
done

if [ ! -d "$PROJECT_PATH/.git" ] && [ ! -f "$PROJECT_PATH/.git" ]; then
    echo "ERROR: $PROJECT_PATH is not a git repo." >&2
    exit 1
fi

PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"
STAGING_BRANCH="$(cd "$PROJECT_PATH" && git symbolic-ref --short HEAD 2>/dev/null || echo main)"

log() { echo "[setup-phases] $*"; }

for phase in ${PHASES//,/ }; do
    worktree_path="${PROJECT_PATH}--${phase}"
    branch="$phase"

    if [ -d "$worktree_path" ]; then
        log "skip $phase — worktree already at $worktree_path"
        continue
    fi

    # Create the branch if it doesn't exist (from staging)
    if ! git -C "$PROJECT_PATH" show-ref --verify --quiet "refs/heads/$branch"; then
        log "creating branch $branch from $STAGING_BRANCH"
        git -C "$PROJECT_PATH" branch "$branch" "$STAGING_BRANCH"
    fi

    log "adding worktree $worktree_path on branch $branch"
    git -C "$PROJECT_PATH" worktree add "$worktree_path" "$branch"

    # Create .papercusp/ in the new worktree with a phase-tagged config.json.
    # Do NOT copy features.json / issues.* — each phase has its own fresh queue.
    mkdir -p "$worktree_path/.papercusp/memory"
    if [ ! -f "$worktree_path/.papercusp/config.json" ]; then
        cat > "$worktree_path/.papercusp/config.json" <<EOF
{
  "phase": "$phase",
  "models": {
    "scoper": "opus",
    "worker": "sonnet",
    "validator": "opus",
    "orchestrator": "haiku",
    "reviewer": "opus"
  }
}
EOF
        log "seeded $worktree_path/.papercusp/config.json with phase=$phase"
    fi

    # Seed the staging worktree's config.json with a phase field if missing.
    if [ -f "$PROJECT_PATH/.papercusp/config.json" ]; then
        if ! grep -q '"phase"' "$PROJECT_PATH/.papercusp/config.json"; then
            log "patching staging config.json to add phase=staging"
            python3 - "$PROJECT_PATH/.papercusp/config.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["phase"] = "staging"
d.setdefault("phases", {
    "staging":    { "port": 5173, "branch": "main" },
    "testing":    { "port": 5174, "branch": "testing" },
    "production": { "port": 5175, "branch": "production" }
})
open(p, "w").write(json.dumps(d, indent=2) + "\n")
PY
        fi
    fi
done

log "done. worktrees:"
git -C "$PROJECT_PATH" worktree list
