#!/usr/bin/env bash
# PreToolUse hook — report a psu worker's native tool call to the cross-CLI
# ACTIVITY BRIDGE (papercusp-worker-integration-2026-06-04, D-003) at the
# START of the call, mirroring posttooluse-activity-report.sh (which reports
# at the END). Fires after EVERY tool call is DISPATCHED (matcher "*"), before
# it runs. The same global seam also repairs Claude's native ToolSearch exact-
# select spelling: Papercusp's canonical `group:verb` names become the MCP id
# Claude indexes (`mcp__papercusp-su__group_verb`).
#
# WHY THIS EXISTS (EI-8997): the D-003 activity-driven plan-item claim
# renewal (plan-items/activity-claim-renewal.ts) rides the SAME bus this
# reports to. Before this hook, the bus only fired on tool COMPLETION
# (PostToolUse) — so a single long-running tool call (a slow Bash
# build/test/diagnostic command) produced ZERO renewal signal for its entire
# duration, and a claim could lapse while its holder was demonstrably mid-
# call on that exact item. Reporting at DISPATCH time too means a renewal
# fires at both ends of a long call, not just the trailing one — halving the
# worst-case gap for a sequence of calls and giving one extra renewal right
# as a long call begins. (It does not fully cover a SINGLE call that outlives
# a whole TTL window on its own — plan_items:heartbeat {kind:'extend'} remains
# the manual backstop for a known-long single op.)
#
# SHARED shape with posttooluse-activity-report.sh (D-002): same JSON-on-
# stdin contract, same scope guard, same fire-and-forget contract. Kept as a
# near-duplicate (not a sourced common lib) so each hook stays a single,
# independently-reviewable file matching the CC hook install pattern — see
# posttooluse-activity-report.sh's own header for the shared-shape rationale.
#
# Precedent: OMP's in-process coord-hook.ts already reports phase:'pre' at its
# tool_call event (D-003) — this brings the Claude/Codex shell-hook chain to
# parity with what OMP has done all along, rather than inventing a new shape.
# Codex-specific caveat (D-006, same as the post-hook's own note): Codex's
# PreToolUse doesn't reliably fire on EDITS, so this degrades to a no-op for
# that subset there; Codex PostToolUse (already wired) still covers it.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

# psu-session gate + install gate (mirror posttooluse-coord-inbox.sh).
if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi

INPUT=$(cat)
AGENT="${PAPERCUSP_AGENT:-}"

# Claude's native ToolSearch index contains client-mangled MCP ids, while every
# Papercusp contract and prompt names tools canonically as `group:verb`. Rewrite
# ONLY the exact-select grammar; ordinary keyword searches, plugin dot names,
# already-mangled ids, and malformed inputs must continue through untouched.
# This hook is global, so PAPERCUSP_SID above is the session-scope guard.
rewrite_tool_search_exact_select() {
  python3 - "$(dirname "$0")" 3<<<"$INPUT" <<'PYEOF'
import json, os, re, sys

sys.path.insert(0, sys.argv[1])
from mcp_response import read_hook_payload  # noqa: E402

try:
    ev = json.loads(read_hook_payload())
except Exception:
    sys.exit(0)
if not isinstance(ev, dict):
    sys.exit(0)

tool_name = ev.get('tool_name') or ev.get('toolName')
tool_input = ev.get('tool_input') or ev.get('toolInput')
if tool_name != 'ToolSearch' or not isinstance(tool_input, dict):
    sys.exit(0)

query = tool_input.get('query')
if not isinstance(query, str):
    sys.exit(0)
match = re.fullmatch(
    r'select:([A-Za-z0-9][A-Za-z0-9_-]*):([A-Za-z0-9][A-Za-z0-9_-]*)',
    query,
)
if not match:
    sys.exit(0)

updated_input = dict(tool_input)
updated_input['query'] = (
    'select:mcp__papercusp-su__' + match.group(1) + '_' + match.group(2)
)
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'updatedInput': updated_input,
    },
}, separators=(',', ':')))
PYEOF
}

REWRITE_OUTPUT=$(rewrite_tool_search_exact_select 2>/dev/null || true)
if [ -n "$REWRITE_OUTPUT" ]; then
  printf '%s\n' "$REWRITE_OUTPUT"
fi

report() {
  python3 - "$OPERATOR_URL" "$TOKEN_PATH" "$PAPERCUSP_SID" "$AGENT" "${PAPERCUSP_HARNESS_SLUG:-}" "$(dirname "$0")" 3<<<"$INPUT" <<'PYEOF'
import hashlib, json, os, re, sys, time, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

operator_url, token_path, owner, agent, harness_slug, hook_dir = sys.argv[1:7]
sys.path.insert(0, hook_dir)
from mcp_response import read_hook_payload, read_token_file  # noqa: E402
raw = read_hook_payload()
token = read_token_file(token_path)
HTTP_TIMEOUT = 3
STR_CAP = 500

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


tool_name = first('tool_name', 'toolName') or ''
tool_input = first('tool_input', 'toolInput')
if not isinstance(tool_input, dict):
    tool_input = {}
tool_use_id = first('tool_use_id', 'toolCallId', 'tool_call_id') or ''
session_id = first('session_id', 'sessionId') or ''
cwd = first('cwd') or ''
role = (os.environ.get('PAPERCUSP_ROLE') or os.environ.get('PAPERCUSP_AGENT_ROLE') or '').strip()


def cap(v):
    if isinstance(v, str):
        return v if len(v) <= STR_CAP else v[:STR_CAP] + '…'
    if isinstance(v, list):
        return '[%d items]' % len(v)
    if isinstance(v, dict):
        return '[object]'
    return v


args = {
    'owner': owner,
    'phase': 'pre',
    'tool_name': tool_name,
    'tool_use_id': tool_use_id,
    'session_id': session_id,
    'cwd': cwd,
    # No status / todos / tool_response on a pre-report — the call hasn't run yet.
    'tool_input': {k: cap(v) for k, v in tool_input.items()},
}
if agent:
    args['agent'] = agent
if role:
    args['role'] = role
if harness_slug:
    args['harness_slug'] = harness_slug

# ── Minimum interval (P-012, review-system-rework-reduction-2026-09-23) ──
# This report exists so a LONG call renews its plan-item claim at dispatch (EI-8997). The
# server already renews at most once per 60s against a >=20m lease
# (plan-items/activity-claim-renewal.ts), so a dispatch report sent within
# PRE_MIN_INTERVAL_SEC of ANY report (pre or post) from this session adds nothing but load.
# Measured before this: 92% of pre reports followed another report by <30s (~2k calls/hour).
# The marker is shared with posttooluse-activity-report.sh (same file names, same key).
PRE_MIN_INTERVAL_SEC = float(os.environ.get('PAPERCUSP_ACTIVITY_PRE_MIN_INTERVAL_SEC') or '30')


def _report_marker(phase):
    cache_dir = os.environ.get('PAPERCUSP_LOCKS_CACHE_DIR') or os.path.join(
        os.path.expanduser('~'), '.papercusp', 'locks-cache')
    key = re.sub(r'[^A-Za-z0-9._-]', '_', os.environ.get('PAPERCUSP_SID') or owner)[:120]
    return os.path.join(cache_dir, f'activity-last-{phase}-{key}')


def _within(path, window):
    try:
        age = time.time() - os.path.getmtime(path)
    except Exception:
        return False
    return 0 <= age < window


if PRE_MIN_INTERVAL_SEC > 0 and any(
        _within(_report_marker(p), PRE_MIN_INTERVAL_SEC) for p in ('pre', 'post')):
    sys.exit(0)

# ── Change of state (RSR-P-012-A, plan decision D-014) ──
# A dispatch report identical to the last one sent (same args minus the per-call
# tool_use_id) is not a change of state, so it is skipped. One exception counts as a
# change: the activity-claim lease is due for renewal. activity:report is the only
# liveness source for activity-mode claims (plan-items/activity-claim-renewal.ts, lease
# >=20m), so an identical report still goes out once KEEPALIVE_SEC has passed since the
# last dispatch report. The fingerprint is the marker file's content.
KEEPALIVE_SEC = float(os.environ.get('PAPERCUSP_ACTIVITY_KEEPALIVE_SEC') or '600')
_fp = hashlib.sha256(json.dumps(
    {k: v for k, v in args.items() if k != 'tool_use_id'}, sort_keys=True, default=str,
).encode()).hexdigest()
try:
    with open(_report_marker('pre')) as _f:
        _last_fp = _f.read().strip()
except Exception:
    _last_fp = ''
if _last_fp == _fp and _within(_report_marker('pre'), KEEPALIVE_SEC):
    sys.exit(0)
try:
    _m = _report_marker('pre')
    os.makedirs(os.path.dirname(_m), mode=0o700, exist_ok=True)
    with open(_m, 'w') as _f:
        _f.write(_fp)
except Exception:
    pass  # an unwritable cache never suppresses the report

body = json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
    'params': {'name': 'activity:report', 'arguments': args},
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
    sys.exit(0)  # operator unreachable / slow → fail open; a missed report is harmless.
PYEOF
}

if [ -n "${PAPERCUSP_ACTIVITY_SYNC:-}" ]; then
  report >/dev/null 2>&1 || true
else
  # Detached fire-and-forget: ( cmd & ) reparents the POST to init and returns now,
  # and the >/dev/null on the subshell releases the hook's stdout pipe immediately.
  ( report >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
fi
exit 0
