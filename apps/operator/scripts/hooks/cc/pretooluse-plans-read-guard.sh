#!/usr/bin/env bash
# PreToolUse hook — teach `plans:get` at the point of failure (P-003(b) of
# kickoff-prompt-absorption-2026-07-17).
#
# WHY THIS EXISTS: a plan's on-disk `docs/plans/<slug>.md` file is a
# PROJECTION of the live plan store — `plans:get` computes each item's
# effectiveStatus (todo/wip/blocked/done, folding in blockedBy resolution),
# decisions, and cross-plan links that the raw markdown bytes do not carry.
# An agent that reaches for `cat` / `Read` / `grep` on that file gets a stale,
# unresolved view AND misses the structured tool entirely — the exact
# failure this hook's sibling absorbers exist to eliminate (see the plan's
# Background section: an ornith session `cat`-ed a plan file 4x, ran `find`,
# then `node -e`, all before ever calling `plans:get`).
#
# SCOPE (deliberately narrow — the feasible subset, per the plan item):
#   - Read: tool_input.file_path is a docs/plans/**/*.md path.
#   - Grep: tool_input.path is EXPLICITLY scoped to a docs/plans (or
#     docs/plans/archive) directory, or a single *.md file under it. A
#     repo-wide/undirected grep (no `path`, or a `path` outside docs/plans)
#     is NEVER blocked here — Grep's flexible glob/path semantics make a
#     broader match too easy to get wrong and would false-positive on
#     legitimate cross-repo searches that merely happen to recurse through
#     docs/plans along the way.
#   - Bash (`cat`/`head`/`sed`/`grep`/… targeting docs/plans/*.md by shell
#     text) IS covered since 2026-08-17 (EI-20720054720826414 follow-through:
#     an agent whose structured multi-plan read clipped fell back to `cat` on
#     the on-disk files — the exact uncovered path this comment used to
#     document as a follow-up). Because shell-text matching is heuristic, the
#     POLARITY FLIPS vs Read/Grep: Bash is denied ONLY when the live identity
#     check CONFIRMS the target is a real plan (plan_exists() is True);
#     not-a-plan AND inconclusive both allow through. A false positive is
#     therefore structurally impossible — the deny fires only on a verified
#     live plan being read as stale bytes — at the cost of failing open when
#     the operator is unreachable, which matches this hook's advisory posture.
#
# IDENTITY-BASED, not just path-based (EI-18645886273852502, 2026-07-25):
# `docs/plans/` is also where outgoing leaders/agents drop hand-written
# agent-to-agent handoff docs that are NOT plans — BRIEF-*.md, SELF-BRIEF-*.md,
# HANDOFF-*.md, DESIGN-*.md, *-runbook.md, *-checklist.md, ...-FLEET-BRIEF.md —
# no single naming convention covers them all, so a filename-prefix allowlist
# would be a whack-a-mole fix. The original guard matched PATH alone and
# blocked these too, then pointed the agent at `plans:get { slug }`, which
# 404s (`not_found`) for a non-plan file — a dead end on the very first tool
# call of a task. Before denying a single-file match, this hook now does a
# best-effort LIVE `plans:get { slug, harness }` identity check (slug = the
# filename minus `.md`) via the local operator: a CONFIRMED not_found means
# the file is not a plan and the Read/Grep is allowed through unmodified; a
# CONFIRMED real plan (or an inconclusive check — operator unreachable,
# unexpected response shape, harness unknown) still gets the deny+teach, the
# same conservative behavior as before. This only ever WIDENS what's
# allowed, never narrows it further. The directory-scoped Grep case (no
# single slug to check) keeps the original path-only deny.
#
# Hint, not a hard wall: this is advisory (deny + teach), same posture as
# the sibling PreToolUse guards in this file (pretooluse-locks-acquire.sh's
# worktree/foreign-workspace guards) — the agent reads
# `permissionDecisionReason`, calls `plans:get`, and moves on; nothing is
# lost, since `plans:get { includeRaw: true }` returns the exact same bytes
# when a caller genuinely needs them.
#
# Fail-open: any parse/path error, or Papercusp not installed, ALWAYS allows
# the read — this hook only ever narrows an otherwise-allowed call. The new
# identity check is itself fail-SAFE toward the old behavior: any failure to
# confirm not_found (timeout, operator down, unknown harness, odd response
# shape) falls back to the original deny+teach rather than allowing through.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
# Managed sessions may receive either the operator origin or its full MCP
# endpoint. Normalize to the origin because the hook appends /api/mcp below.
OPERATOR_URL="${OPERATOR_URL%%/api/mcp*}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
AGENT_ID_PATH="${HOME}/.papercusp/su-agent-id"
if [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi

AGENT_ID=$(cat "$AGENT_ID_PATH" 2>/dev/null || true)
HARNESS="${PAPERCUSP_HARNESS_SLUG:-}"
INPUT=$(cat)

python3 - "$OPERATOR_URL" "$TOKEN_PATH" "$HARNESS" "$AGENT_ID" "$(dirname "$0")" 3<<<"$INPUT" <<'PYEOF' || exit 0
import json, os, re, shlex, sys
import urllib.error, urllib.parse, urllib.request

operator_url = sys.argv[1] if len(sys.argv) > 1 else ''
token_path = sys.argv[2] if len(sys.argv) > 2 else ''
harness = sys.argv[3] if len(sys.argv) > 3 else ''
client_id = sys.argv[4] if len(sys.argv) > 4 else ''
hook_dir = sys.argv[5] if len(sys.argv) > 5 else os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, hook_dir)
from mcp_response import parse_mcp_response, read_hook_payload, read_token_file  # noqa: E402
raw = read_hook_payload()
token = read_token_file(token_path)


def allow():
    sys.exit(0)


def deny(reason):
    json.dump({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'deny',
        'permissionDecisionReason': reason,
    }}, sys.stdout)
    sys.exit(0)


try:
    payload = json.loads(raw)
except Exception:
    allow()

tool_name = payload.get('tool_name', '') or ''
tool_input = payload.get('tool_input', {})
if not isinstance(tool_input, dict):
    allow()

# A docs/plans path, POSIX-normalized, whose LAST two-to-three segments are
# `docs/plans/<file>.md` or `docs/plans/archive/<file>.md`. Captures the
# filename stem (group 3) as the candidate plan slug.
PLAN_FILE_RE = re.compile(r'(^|/)docs/plans(/archive)?/([^/]+)\.md$')
# A directory scoped EXACTLY to docs/plans or docs/plans/archive (trailing
# slash optional) — the narrow Grep `path` case.
PLAN_DIR_RE = re.compile(r'(^|/)docs/plans(/archive)?/?$')


def as_posix(p):
    return p.replace(os.sep, '/') if p else p


def hint(matched_path):
    return (
        f"'{matched_path}' is a plan-file PROJECTION, not the plan's live state — "
        "reading the raw markdown misses computed effectiveStatus (blockedBy "
        "resolution), decisions, and cross-plan links. Call plans:get "
        "{ slug, harness } instead (mode:'full', includeRaw:true if you need the "
        "exact bytes for some other reason)."
    )


_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def plan_exists(slug):
    """Best-effort LIVE identity check via plans:get.
    Returns True  -> CONFIRMED a real plan (deny+teach).
            False -> CONFIRMED not_found, i.e. NOT a plan (allow through).
            None  -> inconclusive (no operator_url/token/harness, transport
                     error, timeout, or an unrecognized response shape) —
                     caller falls back to the old path-only deny so this
                     check can only WIDEN what's allowed, never narrow it.
    """
    if not (operator_url and token and harness and slug):
        return None
    body = json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
        'params': {'name': 'plans:get', 'arguments': {
            'slug': slug, 'harness': harness,
            # EI-20720054720826414: without this, a LARGE real plan's full body
            # hits the result-door and spills, the JSON below fails to parse,
            # and the identity check reads "inconclusive" for exactly the
            # plans most worth guarding. Pick only the existence verdict — a
            # few dozen bytes that can never trip the door.
            'projection': {'pick': ['results[].ok', 'results[].error']},
        }},
    }).encode()
    req = urllib.request.Request(
        operator_url.rstrip('/') + '/api/mcp?superuser=1&origin=hook&format=json&client='
        + urllib.parse.quote(client_id, safe=''),
        data=body,
        headers={
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        },
        method='POST',
    )
    try:
        resp = _opener.open(req, timeout=5)
        raw_resp = resp.read().decode('utf-8', errors='replace')
    except Exception:
        return None

    inner, _rpc_error, phase = parse_mcp_response(raw_resp)
    if phase != 'ok' or not isinstance(inner, dict):
        return None

    try:
        row = (inner.get('results') or [{}])[0]
    except Exception:
        return None
    if row.get('ok') is True:
        return True
    if row.get('error') == 'not_found':
        return False
    return None


def check_plan_file(matched_path, slug):
    if plan_exists(slug) is False:
        allow()
    deny(hint(matched_path))


if tool_name == 'Read':
    fp = tool_input.get('file_path')
    if isinstance(fp, str):
        m = PLAN_FILE_RE.search(as_posix(fp))
        if m:
            check_plan_file(fp, m.group(3))
    allow()

if tool_name == 'Grep':
    p = tool_input.get('path')
    if isinstance(p, str):
        norm = as_posix(p)
        m = PLAN_FILE_RE.search(norm)
        if m:
            check_plan_file(p, m.group(3))
        elif PLAN_DIR_RE.search(norm):
            # No single slug to check identity against — keep the original
            # conservative path-only deny.
            deny(hint(p))
    allow()

# Reader commands whose appearance BEFORE a plan-file path marks the command as
# a read of it. Writers (`echo … > docs/plans/x.md`), `ls`, and commands that
# merely MENTION the string are deliberately not matched.
BASH_READERS_RE = re.compile(r'\b(cat|head|tail|less|more|sed|awk|grep|rg|bat|batcat)\b')

if tool_name == 'Bash':
    cmd = tool_input.get('command')
    if isinstance(cmd, str) and 'docs/plans' in cmd:
        try:
            tokens = shlex.split(cmd)
        except ValueError:
            allow()  # unparseable quoting — heuristic path fails open
        for tok in tokens:
            m = PLAN_FILE_RE.search(as_posix(tok))
            if not m:
                continue
            # Only a READ: a reader command must appear before this path in the
            # command text (a redirection target or bare mention passes).
            at = cmd.find(tok)
            if at <= 0 or not BASH_READERS_RE.search(cmd[:at]):
                continue
            # POLARITY FLIP (see header): shell-text matching is heuristic, so
            # deny ONLY a CONFIRMED live plan — not-a-plan and inconclusive
            # (operator down, no harness) both fall open. A false positive is
            # structurally impossible; a missed deny costs only what the old
            # fully-uncovered Bash path cost on every call.
            if plan_exists(m.group(3)) is True:
                deny(hint(tok))
    allow()

allow()
PYEOF
