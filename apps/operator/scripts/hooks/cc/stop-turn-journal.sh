#!/usr/bin/env bash
# Stop hook — ping the per-turn JOURNAL collector at turn end
# (deterministic-context-carry-2026-07-14 P-012, plan D-003).
#
# The acting agent journals its turn by ending its final message with a line
#   ⟦journal⟧ <1–3 sentences: what landed / where I am / what's next>
# This hook does NO extraction: it POSTs `journal:record-turn` with the session
# id + transcript path and the SERVER extracts (one extractor across every
# client — the mechanical first-line fallback, flagged, when no marker line
# exists). Client-neutral collection per predecessor agent-managed-compaction
# D-002: Claude/Codex ride this cc/ Stop hook; OMP rides its in-process
# turn_end port; both hit the same tool.
#
# SHARED by Claude AND Codex (the same cc/ shell contract the activity /
# lifecycle hooks use): both deliver JSON on stdin with `session_id` +
# `transcript_path` (or camelCase variants); we read whichever is present.
#
# FIRE-AND-FORGET + FAIL-OPEN (the activity-report pattern): a journal ping
# must NEVER block or slow a turn. The POST runs in a DETACHED background
# process; stdout is ALWAYS empty and the exit ALWAYS 0, so no client can
# misread the output or have its turn altered. Set PAPERCUSP_JOURNAL_SYNC=1
# to POST synchronously (tests).
#
# Scope guard: runs ONLY in a psu session (PAPERCUSP_SID set + su-token
# present), exactly like the activity / lifecycle hooks; a plain claude/codex
# elsewhere has no PAPERCUSP_SID and bails instantly.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

# psu-session gate + install gate (mirror posttooluse-activity-report.sh).
if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi

# WI-10004863: a CLI nested inside another agent inherits its PAPERCUSP_SID; journaling
# its turns would file the nested transcript under the su's owner (and its prompt as an
# owner-typed turn). Skip on POSITIVE nested evidence only — helper failure = journal as before.
if python3 "$(dirname "$0")/pc_nested_cli.py" >/dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
AGENT="${PAPERCUSP_AGENT:-}"

report() {
  python3 - "$OPERATOR_URL" "$TOKEN_PATH" "$PAPERCUSP_SID" "$AGENT" "$(dirname "$0")" 3<<<"$INPUT" <<'PYEOF'
import json, os, sys, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy

operator_url, token_path, owner, agent, hook_dir = sys.argv[1:6]
sys.path.insert(0, hook_dir)
from mcp_response import read_hook_payload, read_token_file  # noqa: E402
raw = read_hook_payload()
token = read_token_file(token_path)
HTTP_TIMEOUT = 5

try:
    ev = json.loads(raw)
except Exception:
    sys.exit(0)
if not isinstance(ev, dict):
    sys.exit(0)


def first(*keys):
    for k in keys:
        v = ev.get(k)
        if v not in (None, ''):
            return v
    return None


session_id = first('session_id', 'sessionId') or ''
transcript_path = first('transcript_path', 'transcriptPath') or ''
if not session_id:
    sys.exit(0)

# Codex identifies itself via PAPERCUSP_AGENT; default to claude (the cc Stop
# hook's native client). The transcript adapter kind follows the agent.
agent_kind = (agent or 'claude').strip().lower()
source_kind = agent_kind if agent_kind in ('claude', 'codex', 'omp') else 'claude'

args = {
    'owner': owner,
    'agent': agent_kind,
    'session_id': session_id,
    'source_kind': source_kind,
}
if transcript_path:
    args['transcript_path'] = transcript_path

body = json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
    'params': {'name': 'journal:record-turn', 'arguments': args},
}).encode()
req = urllib.request.Request(
    operator_url.rstrip('/') + '/api/mcp?superuser=1&origin=hook&client='
    + urllib.parse.quote(owner, safe=''),
    data=body,
    headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    },
    method='POST',
)
try:
    urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read()
except Exception:
    sys.exit(0)  # operator unreachable / slow → fail open; a missed journal is recoverable (sessions:search)
PYEOF
}

if [ -n "${PAPERCUSP_JOURNAL_SYNC:-}" ]; then
  report >/dev/null 2>&1 || true
else
  # Detached fire-and-forget: ( cmd & ) reparents the POST to init and returns
  # now; the >/dev/null on the subshell releases the hook's stdout pipe.
  ( report >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
fi
exit 0
