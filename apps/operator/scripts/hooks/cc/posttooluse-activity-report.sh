#!/usr/bin/env bash
# PostToolUse hook — report a psu worker's native tool call to the cross-CLI
# ACTIVITY BRIDGE (papercusp-worker-integration-2026-06-04, D-003), AND (by
# default) fold in the delta-aware coordination bundle (EI-11405 /
# coordination-hook-rpc-fanout-collapse-2026-07-16) that used to be a
# SEPARATE posttooluse-coord-inbox.sh round trip. Fires after EVERY tool call
# (matcher "*"), so each worker's native tool stream (Edit / Write / Bash /
# Read / apply_patch / Task-todos) is mirrored into harness_shared.agent_activity
# → the pui fleet-status view + the curator, AND any NEW coord:inbox messages
# reach the agent mid-turn — in ONE MCP round trip instead of two.
#
# SHARED by Claude AND Codex (D-002): the same `cc/` shell contract. Claude
# PostToolUse and Codex PostToolUse both deliver JSON on stdin with `tool_name` /
# `tool_input` / `tool_use_id` (or `tool_call_id`) / `session_id` / `cwd`; we read
# whichever shape is present. (Codex PreToolUse doesn't fire on edits — D-006 — but
# PostToolUse DOES, so the activity push works on both.)
#
# PAPERCUSP_COORD_FOLD (default "1" = ON): set to "0" to disable the coord fold
# entirely and fall back to the ORIGINAL plain-report contract — detached
# fire-and-forget (PAPERCUSP_ACTIVITY_SYNC=1 forces sync, for tests), no
# hook_bundle, no cursor file, never any stdout. Claude's global settings.json
# never sets this (every psu Claude session — su or role — wants mid-turn coord
# delivery). Codex's per-session hooks.json (role-codex-home.ts) sets it to "0"
# for a ROLE session with no coordSid (roles coordinate via messages:feature_*,
# not the SU coord bus) so that session keeps its original zero-added-latency
# report path; an SU codex session leaves the fold ON, same as Claude.
#
# WHY THE FOLD PATH IS SYNCHRONOUS (EI-11405 — was fire-and-forget-detached):
# the server's `activity:report` tool accepts an optional `hook_bundle` cursor
# (`{generation}`) and, ONLY when the coordination generation has
# actually advanced since our last call, folds a fresh coord:inbox snapshot
# into the SAME response (packages/operator-core/lib/agent-tools/activity/
# hook-bundle.ts). That is the fix for the RPC fanout this hook + the now-
# deleted posttooluse-coord-inbox.sh together caused: N manual tool calls used
# to pay ~2N automatic round trips (one detached activity report + one
# blocking coord:inbox poll, EVERY call); a coord-folding call now pays exactly
# ONE blocking round trip, and the SERVER performs an O(1) (no extra
# inbox/glance query) hydration whenever nothing changed. To read the folded
# result we must wait for the response — hence synchronous. Bounded by
# HTTP_TIMEOUT below so a slow/wedged operator degrades to "no injection this
# call" rather than stalling the agent's turn.
#
# Per-owner CURSOR (generation + the last complete glance snapshot) persists in
# $PAPERCUSP_LOCKS_CACHE_DIR/activity-hook-bundle-<owner>.json — the same
# cache dir + per-owner-file convention the old coord-inbox hook used for its
# `coord-cursor-<owner>.json`. The glance observation time drives a bounded
# refresh of the GLANCE leg on an active tool stream, and the objective-title
# hook reads this same cache instead of making a second coord:glance RPC. The
# server owns the inbox floor; a first call still cannot seed itself past unread
# mail.
#
# Scope guard: runs ONLY in a psu session (PAPERCUSP_SID set + su-token present),
# exactly like the deleted coord-inbox hook. A plain `claude`/`codex` elsewhere has no
# PAPERCUSP_SID and bails instantly. The native session-owner registry may
# supersede a stale ambient SID after a client self-reexec; the resolved owner is
# used for the MCP client, activity row, fold, and cache filename together.
#
# Output contract (Claude Code PostToolUse), unchanged from the old coord-inbox
# hook: exit 0 with
#   { "hookSpecificOutput": { "hookEventName": "PostToolUse",
#       "additionalContext": "..." } }
# injects context for the model's next step WITHOUT a `decision` (so the
# tool result stands and the model is not stopped). Exit 0 + no stdout =
# no-op. We NEVER block a tool and NEVER exit non-zero on a coord/report
# blip — a reporting or coordination failure fails OPEN.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
CACHE_DIR="${PAPERCUSP_LOCKS_CACHE_DIR:-${HOME}/.papercusp/locks-cache}"
COORD_FOLD="${PAPERCUSP_COORD_FOLD:-1}"

# psu-session gate + install gate.
if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi

# WI-10004945: a claude/codex NESTED inside another agent (run from an su's Bash tool,
# or under a capability:bash job) inherited that su's PAPERCUSP_SID. Without this its
# tool calls are reported AS the su, and the coord fold below hands the SU's inbox
# deltas to the nested CLI and advances the su's per-owner bundle cursor, so the su
# never sees those messages itself. Every tool call pays this check, so it reads the
# verdict cached per CLI process (pc_nested_cli.sh), not pc_nested_cli.py directly. A
# missing helper or any failure leaves the condition false: the hook runs as before.
if . "$(dirname "$0")/pc_nested_cli.sh" 2>/dev/null && pc_nested_cli_cached; then
  exit 0
fi

mkdir -p "$CACHE_DIR"
chmod 700 "$CACHE_DIR" 2>/dev/null || true

INPUT=$(cat)
AGENT="${PAPERCUSP_AGENT:-}"

# The reporter: build the activity:report args from the hook stdin, POST, and
# — when COORD_FOLD is on — parse the folded coordination bundle from the
# response. Kept in a function so the coord-folding (always sync) and legacy
# plain-report (detached-by-default) call sites share one body. Any crash
# inside fails open (the `|| true` at the call sites) — a reporting/coord blip
# must never affect a tool.
report() {
  python3 - "$OPERATOR_URL" "$TOKEN_PATH" "$PAPERCUSP_SID" "$AGENT" "$CACHE_DIR" "$COORD_FOLD" "${PAPERCUSP_HARNESS_SLUG:-}" "$(dirname "$0")" 3<<<"$INPUT" <<'PYEOF'
import datetime, hashlib, json, os, re, sys, time, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

operator_url, token_path, owner, agent, cache_dir, coord_fold_flag, harness_slug, hook_dir = sys.argv[1:9]
sys.path.insert(0, hook_dir)
from mcp_response import parse_mcp_response, read_hook_payload, read_token_file, with_native_session  # noqa: E402
from pc_tty import coordination_owner_id  # noqa: E402
raw = read_hook_payload()
token = read_token_file(token_path)
coord_fold = coord_fold_flag != '0'
HTTP_TIMEOUT = 4
STR_CAP = 500
ACTIVITY_HOOK_BUNDLE_SCHEMA = 'activity-hook-bundle-v1'
# The GLANCE display cache TTL — and, since the legs were split, a budget that
# is paid by the glance leg ALONE. It used to set `force_resync`, so this one
# constant governed how often every agent re-hydrated its INBOX too: measured
# over 3h, that made force-resync 61% of all folds (1,946 of 3,170) while only
# 12.7% of folds delivered this owner any mail. Now it refreshes fleet-health
# display and nothing else, so it is free to be coarse (WI-10002436, B).
GLANCE_MAX_AGE_SEC = 60

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
tool_response = first('tool_response', 'toolResponse')
owner = coordination_owner_id(str(session_id), os.environ)
role = (os.environ.get('PAPERCUSP_ROLE') or os.environ.get('PAPERCUSP_AGENT_ROLE') or '').strip()

# Native Claude Grep reports a zero-result search as a plain "No files found"
# or "No matches found" string.  Those strings do not distinguish a completed
# no-match (rg exit 1) from an aborted/failed search (rg exit 2), so surface a
# small advisory rather than letting the agent treat the empty result as proof
# of absence.  Keep this exact-result-only: a positive Grep result may contain
# the same words in matched file content and must remain silent.
GREP_NO_RESULT_RE = re.compile(r'^\s*No (?:files|matches) found\s*\.?\s*$', re.IGNORECASE)
GREP_NO_RESULT_ADVISORY = (
    '⚠ Native Grep returned no results. Treat this zero as UNMEASURED: '
    'run a positive-control search for a token you know exists in the same batch, '
    'then use `rg` via Bash and its exit status before claiming absence.'
)


def response_text(value):
    """Best-effort text extraction for native Grep result envelopes."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return '\n'.join(text for text in (response_text(item) for item in value) if text)
    if isinstance(value, dict):
        for key in ('text', 'content', 'message', 'output', 'result', 'error'):
            text = response_text(value.get(key))
            if text:
                return text
    return ''


grep_no_result_advisory = None
if str(tool_name).strip().casefold() == 'grep':
    response = response_text(tool_response)
    if GREP_NO_RESULT_RE.fullmatch(response):
        grep_no_result_advisory = GREP_NO_RESULT_ADVISORY

# Best-effort status from the tool response (shape is tool-specific; only set when
# clearly determinable so we never mislabel).
status = None
if isinstance(tool_response, dict):
    if tool_response.get('is_error') is True or tool_response.get('error'):
        status = 'error'
    else:
        status = 'ok'

# A todo snapshot (Claude TodoWrite / TaskCreate-TaskUpdate, OMP todo_write) rides in
# tool_input.todos — forward it as `todos` so the server summarises it as kind=todos.
# Codex update_plan uses the sibling whole-list shape `{plan:[{step,status}]}`.
# Normalize that producer shape HERE, before the generic cap() turns every list
# into the irreversible string "[N items]". The same telemetry row can then feed
# both the fleet activity summary and P-030's read-only foreign task projection;
# there is still one hook write and no parallel task store.
todos = tool_input.get('todos') if isinstance(tool_input.get('todos'), list) else None
if str(tool_name).strip().casefold() == 'update_plan' and isinstance(tool_input.get('plan'), list):
    todos = []
    for step in tool_input['plan'][:100]:
        if not isinstance(step, dict):
            continue
        content = step.get('step')
        status_value = step.get('status')
        if not isinstance(content, str) or not content.strip():
            continue
        if status_value not in ('pending', 'in_progress', 'completed'):
            continue
        todos.append({
            'content': content,
            'activeForm': content,
            'status': status_value,
        })


def cap(v):
    if isinstance(v, str):
        return v if len(v) <= STR_CAP else v[:STR_CAP] + '…'
    if isinstance(v, list):
        return '[%d items]' % len(v)
    if isinstance(v, dict):
        return '[object]'
    return v


def emit_context(*parts):
    """Emit PostToolUse context without ever adding a permission decision."""
    values = [part for part in parts if isinstance(part, str) and part.strip()]
    if not values:
        sys.exit(0)
    json.dump({'hookSpecificOutput': {
        'hookEventName': 'PostToolUse',
        'additionalContext': '\n\n'.join(values),
    }}, sys.stdout)
    sys.exit(0)


# ── Minimum interval (P-012, review-system-rework-reduction-2026-09-23) ──
# Measured before this: 48% of post reports followed this session's previous report by <10s
# (bursts of quick calls), ~2.9k calls/hour. Skipping one delays this report's coordination
# fold (inbox delivery, glance refresh) to the next call at most POST_MIN_INTERVAL_SEC later;
# the local nudges above still fire. Throttled against the previous POST only — never against
# the same call's dispatch report (pretooluse-activity-report.sh), or every post after a pre
# would be skipped and the fold would never land. Shares its marker files with that hook.
POST_MIN_INTERVAL_SEC = float(os.environ.get('PAPERCUSP_ACTIVITY_POST_MIN_INTERVAL_SEC') or '10')


def _report_marker(phase):
    key = re.sub(r'[^A-Za-z0-9._-]', '_', os.environ.get('PAPERCUSP_SID') or owner)[:120]
    return os.path.join(cache_dir, f'activity-last-{phase}-{key}')


try:
    _post_age = time.time() - os.path.getmtime(_report_marker('post'))
except Exception:
    _post_age = None
if POST_MIN_INTERVAL_SEC > 0 and _post_age is not None and 0 <= _post_age < POST_MIN_INTERVAL_SEC:
    sys.exit(0)


args = {
    'owner': owner,
    'phase': 'post',
    'tool_name': tool_name,
    'tool_use_id': tool_use_id,
    'session_id': session_id,
    'cwd': cwd,
}
if agent:
    args['agent'] = agent
if role:
    args['role'] = role
if status:
    args['status'] = status
if todos is not None:
    args['todos'] = todos[:100]
else:
    # Cap string fields so a full Write `content` / patch body never bloats the POST.
    args['tool_input'] = {k: cap(v) for k, v in tool_input.items()}
if harness_slug:
    args['harness_slug'] = harness_slug

# ── Change of state (RSR-P-012-A, plan decision D-014) ──
# A completion report identical to the last one sent (same args minus the per-call
# tool_use_id) is not a change of state, so it is skipped. One exception counts as a
# change: the coordination fold is due. This report also carries the inbox/glance fold
# (hook_bundle below), so an identical report still goes out once POST_FOLD_DUE_SEC has
# passed since the last completion report, which bounds directed-message delivery at the
# same 60s as GLANCE_MAX_AGE_SEC. Computed BEFORE hook_bundle is added: the cursor is
# fold bookkeeping, not activity state. The fingerprint is the marker file's content.
POST_FOLD_DUE_SEC = float(os.environ.get('PAPERCUSP_ACTIVITY_POST_FOLD_DUE_SEC') or '60')
_fp = hashlib.sha256(json.dumps(
    {k: v for k, v in args.items() if k != 'tool_use_id'}, sort_keys=True, default=str,
).encode()).hexdigest()
try:
    with open(_report_marker('post')) as _f:
        _last_fp = _f.read().strip()
except Exception:
    _last_fp = ''
if _last_fp == _fp and _post_age is not None and 0 <= _post_age < POST_FOLD_DUE_SEC:
    sys.exit(0)
try:
    _m = _report_marker('post')
    os.makedirs(os.path.dirname(_m), mode=0o700, exist_ok=True)
    with open(_m, 'w') as _f:
        _f.write(_fp)
except Exception:
    pass  # an unwritable cache never suppresses the report

# ── delta-aware coordination fold (EI-11405) — only when COORD_FOLD is on ──
# Cursor is keyed by PAPERCUSP_SID (per-launch), so a fresh session never
# re-shows old mail and never inherits a stale generation from a prior host.

if coord_fold:
    def cursor_path():
        safe = re.sub(r'[^A-Za-z0-9._-]', '_', owner)[:120]
        return os.path.join(cache_dir, f'activity-hook-bundle-{safe}.json')

    def read_cursor():
        try:
            with open(cursor_path()) as f:
                v = json.load(f)
            return v if isinstance(v, dict) else {}
        except Exception:
            return {}

    def write_cursor(gen, glance, glance_observed_at):
        try:
            p = cursor_path()
            tmp = p + '.tmp-' + str(os.getpid())
            state = {'generation': gen}
            if isinstance(glance, dict):
                state['glance'] = glance
            if isinstance(glance_observed_at, str) and glance_observed_at:
                state['glanceObservedAt'] = glance_observed_at
            with open(tmp, 'w') as f:
                f.write(json.dumps(state))
            os.replace(tmp, p)
        except Exception:
            pass

    def observed_epoch(value):
        if not isinstance(value, str) or not value:
            return None
        try:
            parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=datetime.timezone.utc)
            return parsed.timestamp()
        except Exception:
            return None

    cursor = read_cursor()
    raw_generation = cursor.get('generation')
    generation = raw_generation if isinstance(raw_generation, str) and raw_generation else None
    raw_glance = cursor.get('glance')
    cached_glance = raw_glance if isinstance(raw_glance, dict) else None
    raw_observed_at = cursor.get('glanceObservedAt')
    cached_glance_observed_at = raw_observed_at if isinstance(raw_observed_at, str) and raw_observed_at else None

    args['hook_bundle'] = {
        'generation': generation,
    }
    # A null generation already forces a full baseline. Once a generation exists,
    # a missing/corrupt/stale glance asks for the GLANCE leg only, so title/fleet
    # display age stays bounded on an otherwise owner-irrelevant stream WITHOUT
    # dragging the delivery leg through a hydration it did not need.
    #
    # Every condition here is a statement about the DISPLAY CACHE — absent,
    # unparseable, clock-skewed, or simply old. None of them is evidence that
    # this owner has unread mail, which is why none of them may claim
    # `force_resync` (that word means "replace everything" and is the server's
    # documented resync contract). The inbox leg stays governed by the generation
    # gate alone, unchanged and still fail-open.
    if generation is not None:
        observed = observed_epoch(cached_glance_observed_at)
        age = None if observed is None else time.time() - observed
        if cached_glance is None or age is None or age < 0 or age > GLANCE_MAX_AGE_SEC:
            args['hook_bundle']['glance_stale'] = True

body = json.dumps({
    'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
    'params': {'name': 'activity:report', 'arguments': args},
}).encode()
req = urllib.request.Request(
    with_native_session(
        operator_url.rstrip('/') + '/api/mcp?superuser=1&origin=hook&client='
        + urllib.parse.quote(owner, safe=''),
        session_id or os.environ.get('PAPERCUSP_NATIVE_SESSION_ID') or '',
    ),
    data=body,
    headers={
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
    },
    method='POST',
)
try:
    raw_resp = urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read().decode('utf-8', errors='replace')
except Exception:
    # Operator reporting remains fail-open, but a local Grep warning is still
    # useful when the operator is down and must not depend on that RPC.
    emit_context(grep_no_result_advisory)

if not coord_fold:
    emit_context(grep_no_result_advisory)  # plain report — no coord response to fold.

inner, _rpc_error, phase = parse_mcp_response(raw_resp)
if phase != 'ok' or not isinstance(inner, dict):
    emit_context(grep_no_result_advisory)

bundle = inner.get('hook_bundle')
if not isinstance(bundle, dict) or bundle.get('schemaVersion') != ACTIVITY_HOOK_BUNDLE_SCHEMA:
    # No usable bundle (server predates the fold, or errored) — never advance
    # the cursor on a guess; next call retries from the same baseline.
    emit_context(grep_no_result_advisory)

new_generation = bundle.get('generation')
if not isinstance(new_generation, str) or not new_generation:
    new_generation = None
complete = bundle.get('complete') is True
changed = bundle.get('changed') is True
surfaces = bundle.get('surfaces') if isinstance(bundle.get('surfaces'), dict) else {}

context_parts = []

if changed:
    inbox = surfaces.get('inbox') if isinstance(surfaces, dict) else None
    if isinstance(inbox, dict):
        summ = inbox.get('summary') if isinstance(inbox.get('summary'), dict) else {}
        injection = inbox.get('injection')
        if isinstance(injection, str) and injection.strip():
            context_parts.append(injection)
        else:
            # DUMB PIPE parity with the deleted coord-inbox hook (P-015): no new
            # entries, but still surface the ≥80% LOUD context gauge so a
            # heads-down session sees its own usage even on a quiet fold.
            entries = inbox.get('entries')
            if isinstance(entries, list) and not entries:
                gauge = inbox.get('context_gauge')
                if isinstance(gauge, str) and gauge.strip():
                    context_parts.append(gauge)

if grep_no_result_advisory:
    context_parts.append(grep_no_result_advisory)

# Only a COMPLETE fold advances the generation. A fresh glance replaces the
# cached snapshot only when the same complete bundle carries its server
# observation time; changed:false owner-irrelevant advances keep the prior
# snapshot/age. An incomplete fold retains that stale rendering fallback but
# resets generation so the next call retries a FULL hydrate.
new_glance = surfaces.get('glance') if isinstance(surfaces, dict) else None
provenance = bundle.get('provenance') if isinstance(bundle.get('provenance'), dict) else {}
new_glance_observed_at = provenance.get('observedAt') if isinstance(provenance, dict) else None
if complete and isinstance(new_glance, dict) and isinstance(new_glance_observed_at, str) and new_glance_observed_at:
    cached_glance = new_glance
    cached_glance_observed_at = new_glance_observed_at
write_cursor(new_generation if complete else None, cached_glance, cached_glance_observed_at)

emit_context(*context_parts)
PYEOF
}

if [ "$COORD_FOLD" = "0" ]; then
  # Legacy plain-report contract: detached fire-and-forget (never any stdout),
  # unless a test forces sync via PAPERCUSP_ACTIVITY_SYNC.
  if [ -n "${PAPERCUSP_ACTIVITY_SYNC:-}" ]; then
    report >/dev/null 2>&1 || true
  else
    ( report >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
  fi
else
  # Coord-folding contract: always synchronous — the response IS the point.
  report || true
fi
exit 0
