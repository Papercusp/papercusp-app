#!/usr/bin/env bash
# PostToolUse hook — release the lock the matching PreToolUse hook
# acquired. SHARED by Claude Code and Codex (same hook wire format).
#
# Reads the cached lock_id from
#   $PAPERCUSP_LOCKS_CACHE_DIR/<tool_use_id>.lock
# and calls locks:release. If the matching cache is missing, a completed
# Codex code-mode parent may recover an orphaned nested apply_patch token;
# other calls no-op. Always exit 0 so a release failure never blocks the edit;
# emit a PostToolUse context update when release is unconfirmed, because a lock
# can block git-sync for its full TTL.
#
# EI-63: ALSO reads the sidecar $PAPERCUSP_LOCKS_CACHE_DIR/<tool_use_id>.paths
# (written by the matching PreToolUse's _grant()) and, when present, passes it
# as `paths` alongside `lock_id` — scoping the release to exactly the path(s)
# this edit's acquire covered, rather than every path under that lock_id. This
# matters when the server REUSED an existing explicit multi-file lock_id for
# this grant (the owner already held one of these paths under a separate
# deliberate locks:acquire): a bare lock_id release would otherwise delete the
# whole explicit hold, not just this one path. Missing/unreadable sidecar
# falls back to the prior lock_id-only release (unchanged behavior).

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
# Managed sessions may receive either the operator origin or its full MCP
# endpoint. Normalize to the origin because the hook appends /api/mcp below.
OPERATOR_URL="${OPERATOR_URL%%/api/mcp*}"
# A staging-backed Codex session can legitimately coordinate through :3170.
# Releasing its edit lock through only that same process is circular: a server
# edit may restart :3170 before PostToolUse runs. The stable green operator uses
# the same lock store and physical coordination_domain, so it is the safe
# authority fallback for RELEASE only. Override/disable by setting this equal to
# PAPERCUSP_OPERATOR_URL.
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

# Fail-open backstop: release is best-effort (TTL covers a missed one), so
# never let a Python error exit non-zero from this hook.
python3 - "$OPERATOR_URL" "$TOKEN_PATH" "$AGENT_ID" "$CACHE_DIR" "$(dirname "$0")" "$FALLBACK_OPERATOR_URL" 3<<<"$INPUT" <<'PYEOF' || exit 0
import json, os, re, subprocess, sys, time, urllib.request, urllib.parse
from pathlib import Path
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

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
            f.write(json.dumps(value))
        os.replace(tmp, path)
    except Exception:
        pass


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


try:
    payload = json.loads(raw)
except Exception:
    sys.exit(0)

tool_use_id = payload.get('tool_use_id', '')
if not isinstance(tool_use_id, str) or not tool_use_id:
    sys.exit(0)
tool_name = payload.get('tool_name', '') or ''
tool_input = payload.get('tool_input', '')

# Claude's PreToolUse batch path writes a marker for every native edit before
# allowing any member of the batch to run.  Those edits share one union lock;
# releasing one member here would reopen the union while sibling edits are
# still in flight.  The matching PostToolBatch hook owns the single release.
# Codex has no .batch marker and keeps the original per-call lifecycle.
batch_marker_path = os.path.join(cache_dir, tool_use_id + '.batch')
if os.path.exists(batch_marker_path):
    sys.exit(0)

# Identity MUST match the acquirer (the release owner-check requires
# owner == acquirer). PreToolUse resolves PAPERCUSP_SID → session_id →
# agent_id, in that order; mirror it exactly so release matches acquire.
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


def _is_conn_refused(exc):
    if isinstance(exc, ConnectionRefusedError):
        return True
    if isinstance(getattr(exc, 'reason', None), ConnectionRefusedError):
        return True
    text = str(exc)
    return 'Connection refused' in text or 'Errno 111' in text


def _coordination_domain_rejection(value):
    """Return a short detail when an older operator rejects the new arg.

    A release can reach an operator that predates ``coordination_domain`` while
    the matching PreToolUse hook already cached that field. Treat only a
    narrow invalid/unrecognized-key response as a compatibility signal; other
    release errors must retain the normal fail-open behavior.
    """
    try:
        text = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    except Exception:
        text = str(value)
    if 'coordination_domain' not in text:
        return None
    if not re.search(r'invalid[_ -]?args|unrecognized key|unknown key|unexpected key', text, re.I):
        return None
    return text[:300]


RETRY_BACKOFFS = (0.4, 0.8, 1.2)


def cleanup_sidecars(base_path):
    # '.owner' is the claiming session stamped by the PreToolUse hook for the
    # orphan reconcile (EI-22176521893516708); drop it with the rest so a
    # released claim leaves nothing the sweep could later re-examine.
    for suffix in ('.lock', '.paths', '.domain', '.owner'):
        try:
            os.remove(base_path + suffix)
        except Exception:
            pass


def mark_release_success(mode='posttooluse'):
    value = {'ts': now_iso(), 'owner': owner, 'mode': mode}
    write_marker('last-success.json', value)
    write_marker(owner_marker_name('success'), value)


def mark_release_error(phase, detail):
    value = {
        'ts': now_iso(), 'handler': 'posttooluse', 'phase': phase,
        'detail': str(detail)[:200], 'operator_url': operator_url,
        'owner': owner,
    }
    write_marker('last-error.json', value)
    write_marker(owner_marker_name('error'), value)


def emit_release_warning(paths):
    valid_paths = [path for path in paths if isinstance(path, str) and path]
    path_text = ', '.join(valid_paths[:6]) if valid_paths else 'the just-edited path(s)'
    if len(valid_paths) > 6:
        path_text += ', …'
    event = payload.get('hook_event_name')
    if event not in ('PostToolUse', 'PostToolBatch'):
        event = 'PostToolUse'
    context = (
        'LOCK MODE UPDATE: automatic file-lock release was not confirmed after the completed edit for '
        + path_text
        + '. Its lock may remain active. Treat lock handling as manual until a fresh coord:orient reports '
        + 'automatic/verified: inspect locks:queue and explicitly acquire/release before any next file edit.'
    )
    json.dump({'hookSpecificOutput': {
        'hookEventName': event,
        'additionalContext': context,
    }}, sys.stdout)


def run_declaration_regenerator(args, input_text=None):
    """Run the shared enrolled-.mjs filter while this edit's lock is held.

    A generator failure is diagnostic only: callers continue to release so a
    broken declaration emit never strands a source lock for its full TTL.
    """
    helper = os.path.join(hook_dir, 'regenerate-declaration-before-lock-release.mjs')
    if not os.path.isfile(helper):
        return
    try:
        result = subprocess.run(
            ['node', helper] + list(args),
            input=input_text,
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=120,
            check=False,
        )
        if result.returncode != 0:
            mark_release_error(
                'declaration-regeneration',
                (result.stderr or 'generator exited ' + str(result.returncode))[:200],
            )
    except Exception as exc:
        mark_release_error('declaration-regeneration', exc)


def tool_request(name, arguments, base_url):
    body = json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
        'params': {'name': name, 'arguments': arguments},
    }).encode()
    return urllib.request.Request(
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


def call_tool(name, arguments):
    last_exc = None
    origins = [operator_url]
    if fallback_operator_url and fallback_operator_url != operator_url:
        origins.append(fallback_operator_url)
    for attempt in range(len(RETRY_BACKOFFS) + 1):
        # A staging authority can accept the connection but never answer while
        # it is restarting.  That timeout is exactly when the stable operator
        # fallback matters most, so every transport exception advances to the
        # next origin.  Preserve the bounded backoff only when *all* configured
        # origins actively refused the connection; retrying timeouts would turn
        # this best-effort hook into a minute-long PostToolUse stall.
        all_conn_refused = True
        for base_url in origins:
            try:
                raw_response = urllib.request.urlopen(
                    tool_request(name, arguments, base_url), timeout=10,
                ).read().decode('utf-8', errors='replace')
                inner, rpc_error, phase = parse_mcp_response(raw_response)
                if rpc_error is not None:
                    return None, 'rpc: ' + str(rpc_error)[:200]
                if phase in ('no-result', 'no-text'):
                    # HTTP 200 is not a usable release verdict. Advance to the
                    # stable authority when this endpoint returned no parseable
                    # tool result; a repeated locks:release is safe because the
                    # verb confirms an already-absent path as held_before=0.
                    last_exc = RuntimeError('response: ' + str(phase))
                    all_conn_refused = False
                    continue
                if phase != 'ok' or not isinstance(inner, dict):
                    return None, 'response: ' + str(phase)
                return inner, None
            except Exception as exc:
                last_exc = exc
                if not _is_conn_refused(exc):
                    all_conn_refused = False
                continue
        if all_conn_refused and attempt < len(RETRY_BACKOFFS):
            time.sleep(RETRY_BACKOFFS[attempt])
            continue
        break
    return None, str(last_exc)[:200]


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
        return (not expected_paths and bool(released)) or (
            held_before == 0 and not released
        )
    # Compatibility with authorities predating released/held_before.
    return inner.get('ok') is True


CLAUDE_NATIVE_EDIT_TOOLS = {'Edit', 'Write', 'MultiEdit'}
CODEX_NATIVE_EDIT_TOOLS = {'apply_patch', 'write_file', 'edit_file'}


def native_edit_result_succeeded(response):
    """Return True only when a native edit result carries usable success evidence.

    Claude's PostToolUse payload has had both structured and text result shapes.
    A lock claim or a missing result is never evidence; accept explicit success
    markers and the known successful tool-result envelopes, while rejecting every
    explicit error/failure marker. This is deliberately conservative because the
    value is forwarded as edit attribution proof.
    """
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

    # Common Claude tool-result envelopes. A non-empty content/result is a
    # successful response only after the explicit failure checks above.
    for key in ('content', 'result', 'output', 'message', 'filePath', 'file_path',
                'structuredPatch', 'oldString', 'newString', 'path'):
        if key in response and response[key] not in (None, '', []):
            return True
    if response.get('type') in ('text', 'tool_result') and response.get('text'):
        return True
    return False


def native_edit_proof(tool, response, paths):
    """Build positive proof for one successful Claude or Codex native edit."""
    if tool in CLAUDE_NATIVE_EDIT_TOOLS:
        source = 'claude'
    elif tool in CODEX_NATIVE_EDIT_TOOLS:
        source = 'codex'
    else:
        return None
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) and p for p in paths):
        return None
    if not native_edit_result_succeeded(response):
        return None
    return {
        'success': True,
        'source': source,
        'tool': tool,
        'paths': list(paths),
    }


def recover_failed_code_mode_edit(current_cache_path):
    """Release cached nested apply_patch locks when its parent exec completes."""
    if tool_name not in ('exec', 'functions.exec', 'functions__exec'):
        return
    try:
        source = tool_input if isinstance(tool_input, str) else json.dumps(tool_input)
    except Exception:
        return
    if 'apply_patch' not in source or '*** Begin Patch' not in source:
        return

    def path_named_in_patch(path):
        return any(
            marker + path in source
            for marker in (
                '*** Add File: ',
                '*** Update File: ',
                '*** Delete File: ',
                '*** Move to: ',
            )
        )

    for lock_file in Path(cache_dir).glob('*.lock'):
        base = str(lock_file)[:-len('.lock')]
        if str(lock_file) == current_cache_path:
            continue
        try:
            lock_id = lock_file.read_text().strip()
            paths = json.loads(Path(base + '.paths').read_text())
            domain = Path(base + '.domain').read_text().strip()
        except Exception:
            continue
        if not lock_id or not domain or not isinstance(paths, list) or not paths:
            continue
        if not all(isinstance(path, str) and path_named_in_patch(path) for path in paths):
            continue

        queued, queue_error = call_tool('locks:queue', {
            'owner': owner,
            'paths': paths,
        })
        if queue_error is not None or not isinstance(queued, dict):
            mark_release_error('parent-recovery-queue', queue_error or 'invalid queue response')
            emit_release_warning(paths)
            continue
        rows = queued.get('active_locks', queued.get('activeLocks'))
        if not isinstance(rows, list):
            mark_release_error('parent-recovery-queue', 'invalid active_locks response')
            emit_release_warning(paths)
            continue
        owned = [
            row for row in rows
            if isinstance(row, dict)
            and (row.get('lock_id') or row.get('lockId')) == lock_id
            and (row.get('owner') or row.get('ownerId')) == owner
        ]
        if not owned:
            cleanup_sidecars(base)
            continue

        run_declaration_regenerator(
            ['--repo-root', domain] + [arg for path in paths for arg in ('--path', path)]
        )
        released, release_error = call_tool('locks:release', {
            'lock_id': lock_id,
            'paths': paths,
            'coordination_domain': domain,
        })
        if release_error is not None or not release_confirmed(released, paths):
            mark_release_error(
                'parent-recovery-release',
                release_error or released or 'release not confirmed',
            )
            emit_release_warning(paths)
            continue
        cleanup_sidecars(base)
        mark_release_success('parent-recovery')


# Run before any direct release — including the deliberate-explicit-lock case,
# where PreToolUse correctly wrote no release token because the caller's wider
# lock must remain held. The helper classifies success + enrolled paths itself.
run_declaration_regenerator(['--hook-payload'], raw)

cache_path = os.path.join(cache_dir, tool_use_id + '.lock')
if not os.path.exists(cache_path):
    recover_failed_code_mode_edit(cache_path)
    sys.exit(0)

try:
    with open(cache_path) as f:
        lock_id = f.read().strip()
except Exception:
    sys.exit(0)

if not lock_id:
    try:
        os.remove(cache_path)
    except Exception:
        pass
    sys.exit(0)

# EI-63: scope the release to the SPECIFIC path(s) this edit's matching
# PreToolUse acquire covered, when cached (see _grant() in
# pretooluse-locks-acquire.sh). Releasing by lock_id ALONE deletes every path
# under that lock_id — harmless when the lock_id is fresh/unshared (today's
# common case), but WRONG when the server reused an existing EXPLICIT
# multi-file lock_id for this grant (the owner already held one of these
# paths): a bare lock_id release would then silently drop the rest of that
# explicit hold too. Missing/unreadable sidecar (e.g. a cache entry written
# before this fix) falls back to the prior lock_id-only release — unchanged
# behavior, never a regression.
paths_cache_path = os.path.join(cache_dir, tool_use_id + '.paths')
release_paths = None
try:
    with open(paths_cache_path) as f:
        loaded = json.load(f)
    if isinstance(loaded, list) and loaded and all(isinstance(p, str) for p in loaded):
        release_paths = loaded
except Exception:
    pass

# The matching PreToolUse may have acquired through an operator serving a
# different checkout than the edited tree. Carry its physical repo domain
# across the release call; otherwise the release would look in the operator's
# own domain and strand the real lock until TTL.
domain_cache_path = os.path.join(cache_dir, tool_use_id + '.domain')
coordination_domain = None
try:
    with open(domain_cache_path) as f:
        loaded_domain = f.read().strip()
    if loaded_domain:
        coordination_domain = loaded_domain
except Exception:
    pass

release_args = {'lock_id': lock_id}
if release_paths:
    release_args['paths'] = release_paths
if coordination_domain:
    release_args['coordination_domain'] = coordination_domain

# EI-21641025582934324: lock acquisition is intent, not mutation. Only a
# successful recognized Claude edit result may accompany the release, and the
# proof paths must come from the cached paths that this grant actually released.
proof = native_edit_proof(tool_name, payload.get('tool_response', payload.get('toolResponse')), release_paths)
if proof is not None:
    release_args['native_edit_proof'] = proof

# EI-1400: a single-shot release used to give up instantly on ANY transport
# error (including a transient connection-refused during the :3070 restart
# window that follows a lib/** edit — the host has no hot-reload, so an
# operator-code change forces exactly this few-second refuse-then-accept
# window per repo-conventions' two-port model). Silently dropping the
# release there strands the lock SERVER-SIDE for the full 1200s acquire TTL
# (ttl_sec=1200 in the matching PreToolUse hook) even though the edit itself
# finished instantly — to a second agent editing a disjoint file in the same
# directory this reads as prolonged "coarse" blocking on a specific file,
# not a one-off miss. Mirror the PreToolUse hook's own bounded
# connection-refused retry (same backoff shape) so a short restart window
# doesn't turn into a ~20-minute stray lock. Any non-refused error still
# fails open immediately (best-effort; TTL still covers a genuine miss).
# EI-211603: an HTTP 200 is not itself a release verdict. Parse the MCP body,
# confirm the selected paths were released, and retain the cache token on an
# unconfirmed outcome so a parent exec completion can recover it.
released, release_error = call_tool('locks:release', release_args)
compatibility_error = _coordination_domain_rejection(release_error)
if compatibility_error is None:
    compatibility_error = _coordination_domain_rejection(released)
if compatibility_error and coordination_domain:
    # A stale operator may reject the domain field even though it can still
    # release the lock. Retry the same scoped release without that field, and
    # keep every recovery sidecar unless this compatibility retry is confirmed.
    compatibility_args = dict(release_args)
    del compatibility_args['coordination_domain']
    released, release_error = call_tool('locks:release', compatibility_args)
    if release_error is None and release_confirmed(released, release_paths or []):
        mark_release_success('posttooluse-compatibility-fallback')
        cleanup_sidecars(cache_path[:-len('.lock')])
    else:
        mark_release_error('release', release_error or released or 'release not confirmed')
        emit_release_warning(release_paths or [])
elif release_error is None and release_confirmed(released, release_paths or []):
    mark_release_success()
    cleanup_sidecars(cache_path[:-len('.lock')])
else:
    mark_release_error('release', release_error or released or 'release not confirmed')
    emit_release_warning(release_paths or [])

sys.exit(0)
PYEOF
