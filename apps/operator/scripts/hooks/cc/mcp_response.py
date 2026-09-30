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
        try:
            inner = json.loads(item['text'])
        except Exception:
            continue
        if isinstance(inner, dict):
            return inner, None, 'ok'
    return None, None, 'no-text'
