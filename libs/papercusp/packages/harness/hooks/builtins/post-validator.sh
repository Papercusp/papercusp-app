#!/usr/bin/env bash
# Built-in: post-validator hook. Reports child→parent mid-mission status
# when one of:
#   1. The validator returned non-zero (a failing iteration), OR
#   2. The iteration count crosses a threshold (every PAPERCUSP_STATUS_REPORT_EVERY iterations,
#      default 5)
#
# Sends a `kind: 'Status'` message to parent_slug with the validator's outcome.
# No-op if this harness has no parent_slug. User-supplied
# .papercusp/hooks/post-validator.sh overrides this entirely (resolver in run.sh).
#
# Caller env vars (from run.sh):
#   ROLE=validator
#   FEATURE_ID=<id>
#   RC=<exit code; 0 = passed, non-zero = failing>
#   PROJECT_DIR / STATE_DIR

set -e

CONFIG="${STATE_DIR:-.harness}/config.json"
[ -f "$CONFIG" ] || exit 0

PARENT_SLUG="$(jq -r '.parent_slug // empty' "$CONFIG" 2>/dev/null || true)"
[ -z "$PARENT_SLUG" ] && exit 0

TOKEN="$(jq -r '.harness_token // empty' "$CONFIG" 2>/dev/null || true)"
[ -z "$TOKEN" ] && exit 0

SELF_SLUG="$(jq -r '.slug // empty' "$CONFIG" 2>/dev/null || true)"
[ -z "$SELF_SLUG" ] && SELF_SLUG="$(basename "${PROJECT_DIR:-$PWD}")"

REPORT_EVERY="${PAPERCUSP_STATUS_REPORT_EVERY:-5}"
RC="${RC:-0}"
FEATURE_ID="${FEATURE_ID:-?}"

# Track iteration count locally — used to apply REPORT_EVERY throttling.
COUNTER_FILE="${STATE_DIR:-.harness}/.post-validator-counter"
COUNT=0
[ -f "$COUNTER_FILE" ] && COUNT="$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)"
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

# Decide whether to fire:
#   - failing iteration: always
#   - passing iteration: only every Nth
SHOULD_FIRE=false
STATUS_KIND="Status"
SUBJECT=""
if [ "$RC" -ne 0 ]; then
    SHOULD_FIRE=true
    SUBJECT="validator failing for $FEATURE_ID (rc=$RC)"
elif [ $((COUNT % REPORT_EVERY)) -eq 0 ]; then
    SHOULD_FIRE=true
    SUBJECT="iteration $COUNT: validator passing for $FEATURE_ID"
fi

[ "$SHOULD_FIRE" = "false" ] && exit 0

ACTION_ID="$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')"
BASE="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"

curl -sS --max-time 30 -X POST "$BASE/api/admin/execute-action" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "$(jq -nc \
    --arg id "$ACTION_ID" \
    --arg to "$PARENT_SLUG" \
    --arg subject "$SUBJECT" \
    --arg body "Iteration $COUNT, FEATURE_ID=$FEATURE_ID, validator_rc=$RC" \
    --arg reason "post-validator status report from substrate hook" \
    '{actionId: $id, action: {op: "send_message", to: [$to], kind: "Status", subject: $subject, body: $body, reason: $reason}}')" \
  > /dev/null || true
