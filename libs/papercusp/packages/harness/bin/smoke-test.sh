#!/usr/bin/env bash
# Standalone smoke test: runs just the planner in a scratch dir, verifies it
# produced a contract + features.json. Costs < $0.05.

set -eu
HARNESS_DIR="${HARNESS_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
CLAUDE="${AGENT_CMD:-${CLAUDE:-claude -p}}"
AGENT_BACKEND="${AGENT_BACKEND:-}"
if [ -z "$AGENT_BACKEND" ]; then
    case "$CLAUDE" in
        omp*|*/omp*|pi*|*/pi*) AGENT_BACKEND=omp ;;
        *) AGENT_BACKEND=claude-code ;;
    esac
fi
# claude-code wants --dangerously-skip-permissions for headless; omp -p is
# already non-interactive and rejects unknown flags.
SMOKE_EXTRA=""
[ "$AGENT_BACKEND" = "claude-code" ] && SMOKE_EXTRA="--dangerously-skip-permissions"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

echo "Testing in $TEST_DIR"
cd "$TEST_DIR"

cat > SPEC.md <<'EOF'
# Spec

## Goal
A POST /echo endpoint that accepts JSON `{msg:string}` and returns `{ok:true,msg}`.

## Acceptance bar
- curl POST /echo with `{"msg":"hi"}` → `{"ok":true,"msg":"hi"}` HTTP 200.
- curl POST /echo with empty body → HTTP 400.
- curl POST /echo with non-JSON body → HTTP 400.
EOF

mkdir -p .harness
{
    cat "$HARNESS_DIR/prompts/planner.md"
    echo
    echo "---"
    echo "## Runtime context"
    echo "- Working directory: $TEST_DIR"
    echo "- State directory: $TEST_DIR/.papercusp"
} | $CLAUDE $SMOKE_EXTRA > /tmp/planner-smoke.out 2>&1

echo "--- stdout (last 5 lines) ---"
tail -5 /tmp/planner-smoke.out

echo "--- artifacts ---"
if [ -f .papercusp/validation-contract.md ] && [ -f .papercusp/features.json ]; then
    echo "✅ planner produced both artifacts"
    echo
    echo "--- validation-contract.md (head 20) ---"
    head -20 .papercusp/validation-contract.md
    echo
    echo "--- features.json ---"
    cat .papercusp/features.json
    exit 0
else
    echo "❌ planner FAILED to produce artifacts"
    ls -la .papercusp/ 2>/dev/null || echo "(no .harness dir at all)"
    exit 1
fi
