"""Shared runtime helpers for the Claude/Codex shell hooks.

Hook JSON can contain arbitrary tool input and the local MCP bearer is a live
credential.  Neither belongs in a child process's argv, where same-user process
inspection can read it.  Shell wrappers pass the hook payload on fd 3 and only
the permission-restricted token *path* in argv; the helpers below keep that
transport consistent across the hook family.

This module also parses the local MCP endpoint's JSON-RPC/SSE envelope.  The
endpoint can return HTTP 200 while ``result.isError`` is true; that is still a
rejected tool call, not a usable inner payload.
"""

import json
import os
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

OUTPUT_ENVELOPE_SCHEMA_VERSION = 'papercusp.output-envelope/v1'
SCRATCH_URI_PREFIX = 'papercusp://scratch/'


def with_native_session(url, native_session_id):
    """Bind a hook MCP request to its verified native session URL context.

    The MCP host derives request.ctx.advSessionId from this query parameter;
    a JSON-RPC argument named ``session_id`` is telemetry and cannot establish
    the verified request context. Keep other query parameters intact and
    replace any stale native_session value rather than sending duplicates.
    """
    if not isinstance(url, str) or not isinstance(native_session_id, str):
        return url
    native_session_id = native_session_id.strip()
    if not native_session_id:
        return url
    try:
        parts = urlsplit(url)
        query = [
            (key, value)
            for key, value in parse_qsl(parts.query, keep_blank_values=True)
            if key != 'native_session'
        ]
        query.append(('native_session', native_session_id))
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
    except (TypeError, ValueError):
        return url


def _parse_json_object(text):
    if not isinstance(text, str) or not text.strip().startswith('{'):
        return None
    try:
        value = json.loads(text)
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def _scratch_uri_to_path(uri):
    """Resolve only a local scratch URI contained beneath the configured root."""
    if not isinstance(uri, str) or not uri.startswith(SCRATCH_URI_PREFIX):
        return None
    relative = uri[len(SCRATCH_URI_PREFIX):]
    if not relative or '\x00' in relative or any(part == '..' for part in relative.split('/')):
        return None

    root = os.environ.get('PAPERCUSP_SCRATCH_ROOT', '').strip()
    if not root:
        root = os.path.join(os.path.expanduser('~'), '.papercusp', 'scratch')
    root = os.path.realpath(os.path.abspath(root))
    candidate = os.path.realpath(os.path.join(root, *relative.split('/')))
    try:
        if os.path.commonpath((root, candidate)) != root or candidate == root:
            return None
    except (OSError, ValueError):
        return None
    return candidate


def _read_spilled_payload(path):
    """Read the final JSON line from a result-door spill, matching ptool."""
    try:
        last_nonempty = None
        with open(path, 'r', encoding='utf-8', errors='replace') as stream:
            for line in stream:
                if line.strip():
                    last_nonempty = line
        return json.loads(last_nonempty) if last_nonempty else None
    except (OSError, ValueError):
        return None


def _unwrap_output_envelope(value):
    """Return the tool result from a result-door envelope, or None if unreadable.

    References are followed only for the operator's result-door schema and only
    when their scratch URI resolves under this process's scratch root. Preview
    text is deliberately not authoritative: a spilled result is read from disk.
    """
    if not isinstance(value, dict) or value.get('schemaVersion') != OUTPUT_ENVELOPE_SCHEMA_VERSION:
        return value
    if 'ok' in value:
        return value

    for part in value.get('content') or []:
        if not isinstance(part, dict):
            continue
        inline = _parse_json_object(part.get('text'))
        if inline is not None:
            return inline

        if part.get('kind') not in ('reference', 'evidence-reference') and part.get('type') != 'reference':
            continue
        path = _scratch_uri_to_path(part.get('uri'))
        if not path:
            continue
        spilled = _read_spilled_payload(path)
        if not isinstance(spilled, dict):
            continue
        for spilled_part in spilled.get('content') or []:
            if not isinstance(spilled_part, dict):
                continue
            candidate = _parse_json_object(spilled_part.get('text'))
            if candidate is not None:
                return candidate
    return None


def read_hook_payload(fd=3):
    """Read a hook event from a non-argv file descriptor."""
    try:
        with os.fdopen(fd, 'r', encoding='utf-8', errors='replace') as stream:
            return stream.read()
    except OSError:
        return ''


def read_token_file(path):
    """Read the local bearer without ever copying its value into process argv."""
    try:
        with open(path, 'r', encoding='utf-8') as stream:
            return stream.read().strip()
    except OSError:
        return ''


def parse_mcp_response(raw_resp):
    """Return ``(inner, rpc_error, phase)`` for a JSON or SSE MCP response.

    ``inner`` is the JSON object encoded in the first text content block only
    when the outer response is a successful tool result.  ``rpc_error`` holds
    either a JSON-RPC ``error`` object or the rejected outer ``result`` carrying
    ``isError: true``.  ``phase`` is one of ``ok``, ``rpc-error``, ``is-error``,
    ``no-result``, or ``no-text``.
    """
    result = None
    rpc_error = None
    for line in (raw_resp or '').splitlines():
        line = line.strip()
        if not line or line.startswith('event:'):
            continue
        if line.startswith('data:'):
            line = line[5:].strip()
        try:
            candidate = json.loads(line)
        except Exception:
            continue
        if not isinstance(candidate, dict):
            continue
        if 'result' in candidate:
            result = candidate['result']
            break
        if 'error' in candidate:
            rpc_error = candidate['error']
            break

    if rpc_error is not None:
        return None, rpc_error, 'rpc-error'
    if not isinstance(result, dict):
        return None, None, 'no-result'
    if result.get('isError') is True:
        return None, result, 'is-error'

    for item in result.get('content') or []:
        if not isinstance(item, dict) or item.get('type') != 'text':
            continue
        parsed = _parse_json_object(item.get('text'))
        if parsed is None:
            continue
        inner = _unwrap_output_envelope(parsed)
        if inner is not None:
            return inner, None, 'ok'
    return None, None, 'no-text'
