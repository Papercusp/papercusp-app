#!/usr/bin/env bash
# Built-in: notify parent harness on mission completion.
#
# Fires only when this harness has parent_slug set in .papercusp/config.json.
# User-supplied .papercusp/hooks/afterDone.sh overrides this entirely (the
# resolver in run.sh prefers per-harness scripts over builtins).
#
# Auth: reads harness_token from .papercusp/config.json and sends as
# Authorization: Bearer. Identity (from_slug) is server-derived from the
# token, so we only specify `to`.

set -e

CONFIG="${STATE_DIR:-.harness}/config.json"
if [ ! -f "$CONFIG" ]; then exit 0; fi

PARENT_SLUG="$(jq -r '.parent_slug // empty' "$CONFIG" 2>/dev/null || true)"
[ -z "$PARENT_SLUG" ] && exit 0  # no parent, silent success

TOKEN="$(jq -r '.harness_token // empty' "$CONFIG" 2>/dev/null || true)"
[ -z "$TOKEN" ] && { echo "afterDone: no harness_token in config; skipping" >&2; exit 0; }

SELF_SLUG="$(jq -r '.slug // empty' "$CONFIG" 2>/dev/null || true)"
[ -z "$SELF_SLUG" ] && SELF_SLUG="$(basename "${PROJECT_DIR:-$PWD}")"

ACTION_ID="$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')"
BASE="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"

curl -sS --max-time 30 -X POST "$BASE/api/admin/execute-action" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "$(jq -nc \
    --arg id "$ACTION_ID" \
    --arg to "$PARENT_SLUG" \
    --arg subject "mission DONE: $SELF_SLUG" \
    '{actionId: $id, action: {op: "send_message", to: [$to], kind: "Completion", subject: $subject, body: "", reason: "afterDone substrate hook: notifying parent of mission completion"}}')" \
  > /dev/null
