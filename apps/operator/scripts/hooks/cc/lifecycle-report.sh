#!/usr/bin/env bash
# SessionStart / SessionEnd hook — report a worker's session LIFECYCLE into the
# cross-CLI ACTIVITY BRIDGE (papercusp-worker-integration-2026-06-04, D-003). The
# lifecycle counterpart of posttooluse-activity-report.sh: a crisp "worker appeared /
# left" marker (kind='lifecycle') for the pui fleet view, rather than inferring it
# from activity silence.
#
# SHARED by Claude AND Codex (the cc/ contract). One script handles both events: it
# reads `hook_event_name` from stdin (SessionStart → "▶ session started";
# SessionEnd / Stop → "■ session ended"). SessionStart keeps the detached
# fire-and-forget path. SessionEnd is synchronously bounded: activity:report
# classifies it with the existing carry/reset guards, and only a genuine terminal
# verdict reuses the audited admin fleet:kill route to reap an otherwise-live
# managed host (WI-41305). All paths remain fail-open + always-empty-stdout.
#
# Attached: Claude `SessionStart` + `SessionEnd` settings.json entries; managed
# Codex homes register the same two events in hooks.json (verified against the
# installed Codex 0.149.1 hook schema in WI-41305).

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi

INPUT=$(cat)
AGENT="${PAPERCUSP_AGENT:-}"
EVENT_NAME=$(python3 -c 'import json,sys
try:
    o=json.load(sys.stdin)
    print((o.get("hook_event_name") or o.get("hookEventName") or "").strip() if isinstance(o,dict) else "")
except Exception:
    pass' <<<"$INPUT" 2>/dev/null || true)

case "$EVENT_NAME" in
  SessionStart|SessionEnd|Stop) ;;
  *) exit 0 ;;
esac

# WI-10003957: a CLI NESTED inside another agent (a `claude -p` run from an su's Bash
# tool or under a capability:bash job) inherits that su's PAPERCUSP_SID, so without this
# its SessionStart re-anchors the su's adv row and its SessionEnd is judged the su's
# terminal end — which fleet:kill'ed a live su (su-075445e6, 2026-09-29 21:45:42Z).
# The helper exits 0 only on POSITIVE nested evidence; any failure (missing file, no
# /proc, python error) is a non-zero exit, so the hook reports exactly as before.
# activity:report applies the same rule server-side (classifyOwnerNativeSession);
# this is the client half that keeps the foreign report from being sent at all.
if python3 "$(dirname "$0")/pc_nested_cli.py" >/dev/null 2>&1; then
  exit 0
fi

report() {
  python3 - "$OPERATOR_URL" "$TOKEN_PATH" "$PAPERCUSP_SID" "$AGENT" "${PAPERCUSP_HARNESS_SLUG:-}" "$(dirname "$0")" 3<<<"$INPUT" <<'PYEOF'
import json, os, sys, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

operator_url, token_path, owner, agent, harness_slug, hook_dir = sys.argv[1:7]
sys.path.insert(0, hook_dir)
from mcp_response import read_hook_payload, read_token_file  # noqa: E402
raw = read_hook_payload()
token = read_token_file(token_path)
HTTP_TIMEOUT = 3

try:
    ev = json.loads(raw)
except Exception:
    sys.exit(0)
if not isinstance(ev, dict):
    sys.exit(0)

name = (ev.get('hook_event_name') or ev.get('hookEventName') or '').strip()
# Map the event → a lifecycle summary. SessionStart = appeared; SessionEnd / Stop =
# left. Anything else: ignore (we only mark the two endpoints).
if name == 'SessionStart':
    summary = '▶ session started'
elif name in ('SessionEnd', 'Stop'):
    summary = '■ session ended'
else:
    sys.exit(0)

# Role-scoped launches expose PAPERCUSP_ROLE; generic harness children expose
# PAPERCUSP_AGENT_ROLE. Forward the fine-grained role so activity:report can
# apply role-specific lifecycle policy (notably judge's no-inbox-wake rule).
role = (os.environ.get('PAPERCUSP_ROLE') or os.environ.get('PAPERCUSP_AGENT_ROLE') or '').strip()

args = {
    'owner': owner,
    'kind': 'lifecycle',
    'summary': summary,
    'session_id': ev.get('session_id') or ev.get('sessionId') or '',
    'cwd': ev.get('cwd') or '',
}
# Codex hooks receive a minimal environment, so managed homes bake the stable
# adv_sessions row id into this command. Claude normally inherits the same
# variable from its launcher. Forward it when present so SessionStart re-anchors
# the exact row instead of selecting a sibling by mutable started_at ordering.
adv_session_id = os.environ.get('PAPERCUSP_ADV_SESSION_ID') or ''
if adv_session_id:
    try:
        value = int(adv_session_id)
        if value > 0:
            args['adv_session_id'] = value
    except (TypeError, ValueError):
        pass
if agent:
    args['agent'] = agent
if role:
    args['role'] = role
if harness_slug:
    args['harness_slug'] = harness_slug

body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                   'params': {'name': 'activity:report', 'arguments': args}}).encode()
req = urllib.request.Request(
    operator_url.rstrip('/') + '/api/mcp?superuser=1&origin=hook&client=' + urllib.parse.quote(owner, safe=''),
    data=body,
    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
             'Accept': 'application/json, text/event-stream'},
    method='POST')
try:
    response_body = urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read()
except Exception:
    sys.exit(0)

# WI-41305: Codex can end the logical session while its managed PTY host remains
# alive. The response carries activity:report's existing continuation classifier;
# never reproduce that state machine here. Only the exact terminal verdict may
# invoke the already-audited owner-targeted kill path.
if name not in ('SessionEnd', 'Stop'):
    sys.exit(0)

def response_json(raw):
    candidates = [raw.decode('utf-8', 'replace')]
    candidates.extend(
        line[5:].strip()
        for line in candidates[0].splitlines()
        if line.startswith('data:') and line[5:].strip()
    )
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except Exception:
            continue
    return None

outer = response_json(response_body)
result = outer.get('result', outer) if isinstance(outer, dict) else {}
content = result.get('content') if isinstance(result, dict) else None
reported = None
if isinstance(content, list):
    for block in content:
        if not isinstance(block, dict) or block.get('type') != 'text':
            continue
        try:
            reported = json.loads(block.get('text') or '')
        except Exception:
            pass
        if isinstance(reported, dict):
            break

if not isinstance(reported, dict) or reported.get('session_end_disposition') != 'terminal':
    sys.exit(0)

kill_args = {
    'owner': owner,
    'close_terminal': True,
    'reason': 'Native SessionEnd reported a genuine terminal end; reaping its managed PTY host (WI-41305).',
}
kill_req = urllib.request.Request(
    operator_url.rstrip('/') + '/api/admin/coordination/fleet/kill',
    data=json.dumps(kill_args).encode(),
    headers={'Content-Type': 'text/plain'},
    method='POST')
try:
    # The successful request kills this hook's own managed ancestor, so a broken
    # response is expected and irrelevant; dispatching the audited kill is the
    # commitment point.
    urllib.request.urlopen(kill_req, timeout=HTTP_TIMEOUT).read()
except Exception:
    pass
PYEOF
}

if [ "$EVENT_NAME" = "SessionEnd" ] || [ "$EVENT_NAME" = "Stop" ]; then
  # Must consume the terminal-vs-continuation verdict before this hook exits.
  report >/dev/null 2>&1 || true
elif [ -n "${PAPERCUSP_ACTIVITY_SYNC:-}" ]; then
  report >/dev/null 2>&1 || true
else
  ( report >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
fi
exit 0
