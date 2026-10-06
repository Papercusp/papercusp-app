#!/usr/bin/env bash
# PostToolBatch hook — release one complete Claude native edit batch.
#
# PreToolUse elects one batch leader, acquires the union of all edit paths, and
# writes batch-<id>.state.json plus one <tool_use_id>.batch marker per edit.
# PostToolUse deliberately leaves those markers alone.  This hook releases the
# union only when the PostToolBatch payload contains every expected edit and
# every marker agrees with a terminal `granted` state.  Allowed (fail-open),
# denied, malformed, and partial batches are cleaned up without a release:
# there is no lock_id that this hook can safely infer for those cases.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
OPERATOR_URL="${OPERATOR_URL%%/api/mcp*}"
FALLBACK_OPERATOR_URL="${PAPERCUSP_LOCKS_FALLBACK_OPERATOR_URL:-http://localhost:3070}"
FALLBACK_OPERATOR_URL="${FALLBACK_OPERATOR_URL%%/api/mcp*}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
AGENT_ID_PATH="${HOME}/.papercusp/su-agent-id"
CACHE_DIR="${PAPERCUSP_LOCKS_CACHE_DIR:-${HOME}/.papercusp/locks-cache}"

if [ ! -s "$TOKEN_PATH" ] || [ ! -s "$AGENT_ID_PATH" ]; then
  exit 0
fi

AGENT_ID=$(cat "$AGENT_ID_PATH")
INPUT=$(cat)

# Release is best-effort and the acquire TTL is the safety net.  A Python
# failure must never turn PostToolBatch into a non-zero hook that stops Claude.
python3 - "$OPERATOR_URL" "$TOKEN_PATH" "$AGENT_ID" "$CACHE_DIR" "$(dirname "$0")" "$FALLBACK_OPERATOR_URL" 3<<<"$INPUT" <<'PYEOF' || exit 0
import json, os, re, subprocess, sys, time, urllib.request, urllib.parse

urllib.request.install_opener(
    urllib.request.build_opener(urllib.request.ProxyHandler({}))
)

operator_url, token_path, agent_id, cache_dir, hook_dir, fallback_operator_url = sys.argv[1:7]
sys.path.insert(0, hook_dir)
from mcp_response import parse_mcp_response, read_hook_payload, read_token_file  # noqa: E402
raw = read_hook_payload()
token = read_token_file(token_path)


def write_marker(name, value):
    try:
        path = os.path.join(cache_dir, name)
        tmp = path + '.tmp-' + str(os.getpid())
        with open(tmp, 'w') as f:
            json.dump(value, f)
        os.replace(tmp, path)
    except Exception:
        pass


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


try:
    payload = json.loads(raw)
except Exception:
    sys.exit(0)


def tool_ids(value):
    ids = []

    def add(value):
        if isinstance(value, str) and value and value not in ids:
            ids.append(value)

    for key in ('tool_use_ids', 'toolUseIds'):
        values = payload.get(key)
        if isinstance(values, list):
            for value in values:
                if isinstance(value, dict):
                    add(value.get('tool_use_id') or value.get('toolUseId') or value.get('id'))
                else:
                    add(value)
    for key in ('tool_calls', 'toolCalls', 'calls', 'tools'):
        values = payload.get(key)
        if isinstance(values, list):
            for value in values:
                if isinstance(value, dict):
                    add(value.get('tool_use_id') or value.get('toolUseId') or value.get('id'))
                else:
                    add(value)
    add(payload.get('tool_use_id') or payload.get('toolUseId'))
    return ids


ids = tool_ids(payload)
if not ids:
    sys.exit(0)

# Match PreToolUse's owner resolution exactly.  The state owner check below
# prevents a stray PostToolBatch from deleting another session's artifacts.
env_sid = os.environ.get('PAPERCUSP_SID')
lock_sid = os.environ.get('PAPERCUSP_LOCK_SID')
session_id = payload.get('session_id')


def diagnostic_lock_sid():
    try:
        codex_home = os.environ.get('CODEX_HOME')
        if not codex_home:
            return None
        with open(os.path.join(codex_home, 'papercusp-diagnostics.json')) as f:
            value = json.load(f).get('lockOwnerSid')
        return value if isinstance(value, str) and value else None
    except Exception:
        return None


owner = (
    lock_sid if isinstance(lock_sid, str) and lock_sid
    else diagnostic_lock_sid() or (
        env_sid if isinstance(env_sid, str) and env_sid
        else session_id if isinstance(session_id, str) and session_id
        else agent_id)
)


def owner_marker_name(kind):
    safe = re.sub(r'[^A-Za-z0-9._-]', '_', owner)[:160] or 'unknown'
    return 'owner-' + safe + '-last-' + kind + '.json'


def regenerate_declarations(state):
    """Regenerate selected enrolled sources before releasing the batch union."""
    root = state.get('coordination_domain')
    paths = state.get('paths')
    helper = os.path.join(hook_dir, 'regenerate-declaration-before-lock-release.mjs')
    if (not isinstance(root, str) or not root
            or not isinstance(paths, list) or not paths
            or not all(isinstance(path, str) and path for path in paths)
            or not os.path.isfile(helper)):
        return
    try:
        result = subprocess.run(
            ['node', helper, '--repo-root', root]
            + [arg for path in paths for arg in ('--path', path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
            check=False,
        )
        if result.returncode != 0:
            value = {
                'ts': now_iso(), 'handler': 'posttoolbatch',
                'phase': 'declaration-regeneration',
                'detail': (result.stderr or 'generator exited ' + str(result.returncode))[:200],
                'operator_url': operator_url, 'owner': owner,
            }
            write_marker('last-error.json', value)
            write_marker(owner_marker_name('error'), value)
    except Exception as exc:
        value = {
            'ts': now_iso(), 'handler': 'posttoolbatch',
            'phase': 'declaration-regeneration', 'detail': str(exc)[:200],
            'operator_url': operator_url, 'owner': owner,
        }
        write_marker('last-error.json', value)
        write_marker(owner_marker_name('error'), value)


def read_json(path):
    try:
        with open(path) as f:
            value = json.load(f)
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def remove(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    except Exception:
        pass


def marker_paths_for_batch(batch_id):
    paths = []
    try:
        names = os.listdir(cache_dir)
    except Exception:
        return paths
    for name in names:
        if not name.endswith('.batch'):
            continue
        path = os.path.join(cache_dir, name)
        marker = read_json(path)
        if marker and marker.get('batch_id') == batch_id:
            paths.append(path)
    return paths


def cleanup_batch(batch_id, state_path, processing_path):
    for path in marker_paths_for_batch(batch_id):
        remove(path)
    remove(state_path)
    remove(processing_path)
    remove(os.path.join(cache_dir, 'batch-' + batch_id + '.leader'))


def claim_state(state_path):
    # Renaming the state is the one-shot barrier.  A duplicate PostToolBatch
    # sees neither the live state nor a second releasable copy, so it cannot
    # issue a second locks:release while the first caller is in flight.
    processing_path = state_path + '.processing'
    try:
        os.rename(state_path, processing_path)
        return processing_path
    except FileNotFoundError:
        return None
    except FileExistsError:
        return None
    except Exception:
        return None


def is_complete_granted(state, batch_id):
    if state.get('batch_id') != batch_id or state.get('status') != 'granted':
        return False
    expected = state.get('tool_use_ids')
    if not isinstance(expected, list) or not expected or not all(isinstance(x, str) and x for x in expected):
        return False
    expected = list(dict.fromkeys(expected))
    if not set(expected).issubset(set(ids)):
        return False
    for tool_id in expected:
        marker = read_json(os.path.join(cache_dir, tool_id + '.batch'))
        if not marker or marker.get('batch_id') != batch_id or marker.get('status') != 'granted':
            return False
    return True


NATIVE_EDIT_TOOLS = {'Edit', 'Write', 'MultiEdit'}


def native_edit_result_succeeded(response):
    """Conservatively classify a native edit result as successful."""
    if response is None:
        return False
    if isinstance(response, bool):
        return response
    if isinstance(response, str):
        text = response.strip()
        if not text:
            return False
        return not re.match(r'^(?:error|failed|failure|denied|permission denied)\b', text, re.I)
    if isinstance(response, list):
        return bool(response) and all(native_edit_result_succeeded(item) for item in response)
    if not isinstance(response, dict):
        return False
    if response.get('is_error') is True or response.get('isError') is True:
        return False
    if response.get('ok') is False or response.get('success') is False:
        return False
    status = response.get('status')
    if isinstance(status, str) and status.lower() in {'error', 'failed', 'failure', 'denied'}:
        return False
    if response.get('error'):
        return False
    if response.get('ok') is True or response.get('success') is True:
        return True
    if response.get('is_error') is False or response.get('isError') is False:
        return True
    if isinstance(status, str) and status.lower() in {'ok', 'success', 'succeeded', 'completed', 'applied'}:
        return True
    for key in ('content', 'result', 'output', 'message', 'filePath', 'file_path',
                'structuredPatch', 'oldString', 'newString', 'path'):
        if key in response and response[key] not in (None, '', []):
            return True
    if response.get('type') in ('text', 'tool_result') and response.get('text'):
        return True
    return False


def result_records():
    """Index PostToolBatch records by tool_use_id across Claude wire aliases."""
    records = {}
    for key in ('tool_calls', 'toolCalls', 'calls', 'tools', 'tool_results', 'toolResults', 'results', 'responses'):
        values = payload.get(key)
        if not isinstance(values, list):
            continue
        for value in values:
            if not isinstance(value, dict):
                continue
            tool_id = value.get('tool_use_id') or value.get('toolUseId') or value.get('id')
            if isinstance(tool_id, str) and tool_id:
                records[tool_id] = value
    return records


def native_edit_batch_proof(state):
    """Require one successful recognized result for every expected edit."""
    expected = state.get('tool_use_ids')
    paths = state.get('release_paths')
    if not isinstance(expected, list) or not expected or not all(isinstance(x, str) and x for x in expected):
        return None
    if not isinstance(paths, list) or not paths or not all(isinstance(x, str) and x for x in paths):
        return None
    records = result_records()
    tools = []
    for tool_id in dict.fromkeys(expected):
        record = records.get(tool_id)
        if not isinstance(record, dict):
            return None
        tool = record.get('tool_name') or record.get('toolName') or record.get('name')
        response = None
        for key in ('tool_response', 'toolResponse', 'tool_result', 'toolResult', 'response', 'result', 'output'):
            if key in record:
                response = record[key]
                break
        if tool not in NATIVE_EDIT_TOOLS or not native_edit_result_succeeded(response):
            return None
        tools.append(tool)
    return {
        'success': True,
        'source': 'claude',
        'tools': tools,
        'paths': list(paths),
    }


def release_confirmed(inner, expected_paths):
    if not isinstance(inner, dict) or inner.get('ok') is False:
        return False
    row = inner
    results = inner.get('results')
    if isinstance(results, list) and results:
        rows = [result for result in results if isinstance(result, dict)]
        if not rows or any(result.get('ok') is False for result in rows):
            return False
        row = rows[0]
    released = row.get('released')
    held_before = row.get('held_before', row.get('heldBefore'))
    if isinstance(released, list):
        if expected_paths and all(path in released for path in expected_paths):
            return True
        return (not expected_paths and bool(released)) or (held_before == 0 and not released)
    # Compatibility with authorities predating released/held_before.
    return inner.get('ok') is True


def mark_release_error(phase, detail, paths=None):
    value = {
        'ts': now_iso(), 'handler': 'posttoolbatch', 'phase': phase,
        'detail': str(detail)[:200], 'operator_url': operator_url, 'owner': owner,
    }
    write_marker('last-error.json', value)
    write_marker(owner_marker_name('error'), value)
    valid_paths = [path for path in (paths or []) if isinstance(path, str) and path]
    path_text = ', '.join(valid_paths[:6]) if valid_paths else 'the completed edit batch'
    if len(valid_paths) > 6:
        path_text += ', …'
    event = payload.get('hook_event_name')
    if event not in ('PostToolUse', 'PostToolBatch'):
        event = 'PostToolBatch'
    context = (
        'LOCK MODE UPDATE: automatic file-lock release was not confirmed for '
        + path_text
        + '. Its lock may remain active. Treat lock handling as manual until a fresh coord:orient reports '
        + 'automatic/verified: inspect locks:queue and explicitly acquire/release before any next file edit.'
    )
    json.dump({'hookSpecificOutput': {
        'hookEventName': event,
        'additionalContext': context,
    }}, sys.stdout)


def release_batch(state, proof=None):
    lock_id = state.get('lock_id')
    if not isinstance(lock_id, str) or not lock_id:
        return False
    release_args = {'lock_id': lock_id}
    release_paths = state.get('release_paths')
    if isinstance(release_paths, list) and release_paths and all(isinstance(x, str) for x in release_paths):
        release_args['paths'] = release_paths
    domain = state.get('coordination_domain')
    if isinstance(domain, str) and domain:
        release_args['coordination_domain'] = domain
    if proof is not None:
        release_args['native_edit_proof'] = proof
    body = json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
        'params': {'name': 'locks:release', 'arguments': release_args},
    }).encode()
    def refused(exc):
        if isinstance(exc, ConnectionRefusedError):
            return True
        if isinstance(getattr(exc, 'reason', None), ConnectionRefusedError):
            return True
        text = str(exc)
        return 'Connection refused' in text or 'Errno 111' in text

    origins = [operator_url]
    if fallback_operator_url and fallback_operator_url != operator_url:
        origins.append(fallback_operator_url)
    backoffs = (0.4, 0.8, 1.2)
    last_detail = None
    last_phase = 'connect'
    for attempt in range(len(backoffs) + 1):
        all_conn_refused = True
        for base_url in origins:
            req = urllib.request.Request(
                base_url.rstrip('/') + '/api/mcp?superuser=1&origin=hook&client='
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
                raw_response = urllib.request.urlopen(req, timeout=10).read().decode('utf-8', errors='replace')
                inner, rpc_error, phase = parse_mcp_response(raw_response)
                if rpc_error is not None:
                    mark_release_error('release', 'rpc: ' + str(rpc_error), release_paths)
                    return False
                if phase in ('no-result', 'no-text'):
                    # An empty HTTP 200 is not proof that the batch lock was
                    # released. Try the stable authority; repeated release is
                    # safe because the verb confirms an already-absent path.
                    last_detail = 'response: ' + str(phase)
                    last_phase = 'release'
                    all_conn_refused = False
                    continue
                if phase != 'ok' or not isinstance(inner, dict):
                    mark_release_error('release', 'response: ' + str(phase), release_paths)
                    return False
                if not release_confirmed(inner, release_paths if isinstance(release_paths, list) else []):
                    mark_release_error('release', inner or 'release not confirmed', release_paths)
                    return False
                return True
            except Exception as exc:
                last_detail = str(exc)
                if not refused(exc):
                    all_conn_refused = False
        if all_conn_refused and attempt < len(backoffs):
            time.sleep(backoffs[attempt])
            continue
        break
    mark_release_error(last_phase, last_detail or 'release not confirmed', release_paths)
    return False


# A PostToolBatch can contain ordinary read/tool calls alongside the edit
# batch.  Marker-derived grouping therefore ignores unrelated IDs while still
# requiring every expected edit ID from each state.
groups = {}
for tool_id in ids:
    marker = read_json(os.path.join(cache_dir, tool_id + '.batch'))
    batch_id = marker.get('batch_id') if marker else None
    if isinstance(batch_id, str) and batch_id:
        groups.setdefault(batch_id, []).append(tool_id)

for batch_id in groups:
    state_path = os.path.join(cache_dir, 'batch-' + batch_id + '.state.json')
    state = read_json(state_path)
    if not state:
        continue
    state_owner = state.get('owner')
    if isinstance(state_owner, str) and state_owner and state_owner != owner:
        continue
    processing_path = claim_state(state_path)
    if not processing_path:
        continue
    try:
        # Only a complete terminal granted state can release.  All other
        # statuses, including allowed/denied/running and partial payloads,
        # intentionally skip the network write and only clean local artifacts.
        if is_complete_granted(state, batch_id):
            proof = native_edit_batch_proof(state)
            if proof is not None:
                regenerate_declarations(state)
                if release_batch(state, proof):
                    write_marker('last-success.json', {'ts': now_iso(), 'owner': owner})
                    write_marker(owner_marker_name('success'), {'ts': now_iso(), 'owner': owner})
        # Cleanup occurs for every state we successfully claimed.  A failed
        # release is still safe: the server-side acquire TTL remains the guard.
    finally:
        cleanup_batch(batch_id, state_path, processing_path)

sys.exit(0)
PYEOF
