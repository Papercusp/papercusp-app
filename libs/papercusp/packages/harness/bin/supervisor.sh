#!/usr/bin/env bash
# Nightly supervisor. Wakes up every N hours, reviews progress, decides whether
# to: add new milestones, unstick blocked features, or ping a human.
#
# Install via cron:
#   0 */6 * * * cd /path/to/project && ~/autonomous-harness/bin/supervisor.sh
#
# Or chain into `run.sh` to trigger only when the harness exits with code 3 (escalated).

set -u
HARNESS_DIR="${HARNESS_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="${PROJECT_DIR:-$PWD}"
STATE_DIR="$PROJECT_DIR/.papercusp"
CLAUDE="${AGENT_CMD:-${CLAUDE:-claude -p}}"
NOTIFY="${NOTIFY:-}" # override with a command like "pushnotify" or "slack-send"

cd "$PROJECT_DIR"
[ -d "$STATE_DIR" ] || { echo "no .harness dir; nothing to supervise"; exit 0; }

{
    cat <<'EOF'
You are the SUPERVISOR. You wake up periodically to check on the autonomous harness
running in this project. You run in a fresh context.

## Your ONE job this run

Read:
- `SPEC.md`
- `.papercusp/validation-contract.md`
- `.papercusp/features.json`
- `.papercusp/issues.md` (if present, focus on last 2 rounds)
- `.papercusp/escalation.md` (if present)
- Recent entries in `.papercusp/logs/run.log`

Decide ONE outcome:

### A. "progressing" — workers are making forward progress, don't interfere.
Print: `SUPERVISOR: progressing`

### B. "unblock" — A feature has been stuck (attempts >= 5) on a specific root cause.
Write a clarification or revised spec to `.papercusp/supervisor-notes.md`,
reset that feature's `attempts` counter in `features.json`, and mark its
status back to `todo`.
Print: `SUPERVISOR: unblocked <FEATURE_ID>`

### C. "expand" — original spec is mostly done and new work should be considered.
If >80% of features are `passed`, look at `SPEC.md` again. Are there
opportunities for additional milestones? If so, write them to
`.papercusp/supervisor-notes.md` for the next planner run.
Print: `SUPERVISOR: expanded <N>`

### D. "human" — can't make progress without human input.
Write a specific question to `.papercusp/escalation.md`. Keep it short.
Print: `SUPERVISOR: human-needed`

## Rules

- You do not write code.
- You do not reorder the feature queue aggressively — one small nudge per run.
- If nothing needs doing, say so.
EOF
} | $CLAUDE > "$STATE_DIR/logs/supervisor-$(date +%s).out" 2>&1

result="$(tail -1 "$STATE_DIR/logs/supervisor-"*.out 2>/dev/null | tail -1)"
echo "$(date -Iseconds) $result" >> "$STATE_DIR/logs/supervisor-history.log"

# POST whatever escalation/supervisor-notes the LLM wrote to the
# operator's PG row (replaces the chokidar mirror).
_post_supervisor_escalation() {
    local operator_base="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
    local harness_token=""
    if [ -f "$STATE_DIR/config.json" ]; then
        harness_token="$(jq -r '.harness_token // empty' "$STATE_DIR/config.json" 2>/dev/null || true)"
    fi
    [ -z "$harness_token" ] && return 0
    local esc="" notes=""
    [ -f "$STATE_DIR/escalation.md" ] && esc="$(head -c 262144 "$STATE_DIR/escalation.md" 2>/dev/null || true)"
    [ -f "$STATE_DIR/supervisor-notes.md" ] && notes="$(head -c 262144 "$STATE_DIR/supervisor-notes.md" 2>/dev/null || true)"
    [ -z "$esc" ] && [ -z "$notes" ] && return 0
    local body
    body="$(ESC="$esc" NOTES="$notes" python3 -c '
import json, os, sys
out = {"phase": "staging"}
if os.environ.get("ESC"):   out["escalation"]       = os.environ["ESC"]
if os.environ.get("NOTES"): out["supervisorNotes"]  = os.environ["NOTES"]
sys.stdout.write(json.dumps(out))
' 2>/dev/null)" || return 0
    curl -sS -X POST -H 'content-type: application/json' \
        -H "Authorization: Bearer $harness_token" \
        --max-time 5 \
        -d "$body" "$operator_base/api/internal/escalation-event" >/dev/null 2>&1 || true
}
_post_supervisor_escalation &

if [ -n "$NOTIFY" ] && grep -q "human-needed\|expand" <<<"$result"; then
    $NOTIFY "Harness supervisor: $result ($PROJECT_DIR)"
fi
