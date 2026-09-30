#!/usr/bin/env bash
# PostToolUse + Stop/SessionEnd hook — the PER-TURN VERIFY-not-CREATE work-item
# BACKSTOP (enforce-system-on-generic-work-2026-06-29, P-019). The lightweight
# safety net BEHIND the prompt directive (P-015): when a psu session ENDS A TURN
# having edited workspace code but holds NO objective in the ledger (no
# in-execution work-item AND no declared coord intent → coord:glance self.objective
# is empty), emit ONE short reminder to open a work-item. It NEVER creates anything
# — it only reminds. Explicitly DISTINCT from the rejected per-edit auto-capture
# hook: the granularity is per-TURN (Stop), not per-edit (so no granularity problem),
# and once-per-session (a `.done` marker de-dupes after the first nudge).
#
# SHARED by Claude / Codex / OMP (the same cc/ shell contract the lock / activity /
# lifecycle hooks use). ONE script, two phases keyed off `hook_event_name`:
#   • PostToolUse(Edit|Write|MultiEdit|apply_patch|write_file|edit_file) → mark this
#     session as having edited WORKSPACE code (a local touch in the lock-cache,
#     `wi-nudge-<SID>.edited`; no network, no flag check — cheap + harmless), and
#     append each edited PRODUCT-SOURCE path (not tests / docs / *.md) to
#     `wi-nudge-<SID>.files` for the multi-file check below.
#   • Stop / SessionEnd → if (this session has an `.edited` marker) AND (not already
#     nudged) AND (the backstop flag is ON) AND either
#       (1) coord:glance self.objective is CONFIRMED empty, or
#       (2) the objective is non-empty BUT the session edited ≥
#           PAPERCUSP_WORKITEM_NUDGE_MULTIFILE_THRESHOLD (default 3; 0 disables)
#           distinct product-source files — a standing objective (fleet lead /
#           armed loop / monitor) is NOT registration for a multi-file code change
#           (agent-change-traceability-discipline-2026-07-10 P-002),
#     → emit the reminder (durable local log + a coord activity note + stderr) and
#     write the `.done` marker. The objective-holding nudge is VERIFY-phrased: it
#     names the objective and asks the agent to confirm coverage, never accuses.
#
# GATED behind the `papercusp-workitem-verify-nudge` feature flag (DEFAULT ON;
# registered in @papercusp/flags, deliberately NOT in DARK_FLAGS). An owner can flip
# it OFF to silence the backstop. FAIL-OPEN to ON: if the flag can't be resolved
# (operator down / the deployed operator predates the flag) we still nudge.
#
# FIRE-AND-FORGET + FAIL-OPEN: a backstop nudge must NEVER block or slow a session.
# By default the work runs in a DETACHED background process (zero added latency on
# the tool / turn stream); stdout is ALWAYS empty and the exit is ALWAYS 0, so no
# client can misread the output or have its turn altered. Set
# PAPERCUSP_WORKITEM_NUDGE_SYNC=1 to run synchronously (tests).
#
# Scope guard: runs ONLY in a psu session (PAPERCUSP_SID set + su-token present),
# exactly like the activity / objective-title / lifecycle hooks; a plain
# claude/codex/omp elsewhere has no PAPERCUSP_SID and bails instantly.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
CACHE_DIR="${PAPERCUSP_LOCKS_CACHE_DIR:-${HOME}/.papercusp/locks-cache}"
WORKSPACE_ROOT="${PAPERCUSP_WORKSPACE_ROOT:-${HOME}/papercupai-workspace}"
FLAG_KEY="papercusp-workitem-verify-nudge"

# psu-session + install gate (mirror posttooluse-activity-report.sh).
if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi
AGENT="${PAPERCUSP_AGENT:-}"
# Drain stdin (the hook event JSON) so the pipe closes cleanly.
INPUT="$(cat 2>/dev/null || true)"

mkdir -p "$CACHE_DIR" 2>/dev/null || true

run() {
  python3 - "$OPERATOR_URL" "$TOKEN_PATH" "$PAPERCUSP_SID" "$CACHE_DIR" "$WORKSPACE_ROOT" "$FLAG_KEY" "$AGENT" "$(dirname "$0")" 3<<<"$INPUT" <<'PYEOF'
import json, os, sys, time, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

operator_url, token_path, sid, cache_dir, workspace_root, flag_key, agent, hook_dir = sys.argv[1:9]
sys.path.insert(0, hook_dir)
from mcp_response import read_hook_payload, read_token_file  # noqa: E402
raw = read_hook_payload()
token = read_token_file(token_path)
HTTP_TIMEOUT = 3
EDIT_TOOLS = {'Edit', 'Write', 'MultiEdit', 'apply_patch', 'write_file', 'edit_file'}


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def safe(s):
    out = ''.join(c if (c.isalnum() or c in '-_.') else '_' for c in (s or ''))
    return out[:120] or 'nosid'


sid_safe = safe(sid)
edited_marker = os.path.join(cache_dir, 'wi-nudge-' + sid_safe + '.edited')
files_marker = os.path.join(cache_dir, 'wi-nudge-' + sid_safe + '.files')
done_marker = os.path.join(cache_dir, 'wi-nudge-' + sid_safe + '.done')
log_path = os.environ.get('PAPERCUSP_WORKITEM_NUDGE_LOG') or os.path.join(cache_dir, 'wi-nudge.log')

try:
    ev = json.loads(raw)
except Exception:
    sys.exit(0)
if not isinstance(ev, dict):
    sys.exit(0)

name = (ev.get('hook_event_name') or ev.get('hookEventName') or '').strip()


def is_product_source(p):
    """Tests, specs, docs and markdown don't count toward the multi-file trigger —
    only product-source edits suggest an unregistered code change."""
    low = p.replace(os.sep, '/').lower()
    base = os.path.basename(low)
    if base.endswith('.md'):
        return False
    if '.test.' in base or '.spec.' in base:
        return False
    if '/__tests__/' in low or '/docs/' in low:
        return False
    return True


# ── PostToolUse: mark this session as having edited WORKSPACE code ──────────────
# Local-only, no network, no flag check (cheap + harmless even when the flag is OFF).
if name == 'PostToolUse':
    tool_name = ev.get('tool_name') or ev.get('toolName') or ''
    if tool_name not in EDIT_TOOLS:
        sys.exit(0)
    ti = ev.get('tool_input') or ev.get('toolInput') or {}
    cwd = ev.get('cwd') or os.getcwd()
    concrete = []
    if isinstance(ti, dict):
        for k in ('file_path', 'path'):
            v = ti.get(k)
            if isinstance(v, str) and v:
                concrete.append(v)
    # Scope to the workspace: a concrete file path must resolve under WORKSPACE_ROOT;
    # with no concrete path (e.g. codex apply_patch text) fall back to the cwd scope.
    in_ws = False
    ws_paths = []
    try:
        ws_real = os.path.realpath(workspace_root)
        if concrete:
            for p in concrete:
                ap = p if os.path.isabs(p) else os.path.join(cwd, p)
                ap = os.path.realpath(ap) if os.path.exists(ap) else os.path.abspath(ap)
                if ap == ws_real or ap.startswith(ws_real + os.sep):
                    in_ws = True
                    ws_paths.append(ap)
        else:
            cr = os.path.realpath(cwd) if os.path.exists(cwd) else os.path.abspath(cwd)
            in_ws = (cr == ws_real or cr.startswith(ws_real + os.sep))
    except Exception:
        in_ws = True  # fail-open: if scoping errors, count the edit (nudge > miss).
    if not in_ws:
        sys.exit(0)
    try:
        with open(edited_marker, 'w') as f:
            f.write(json.dumps({'sid': sid, 'last': now_iso()}))
    except Exception:
        pass
    # Append product-source paths for the multi-file check (duplicates fine —
    # the Stop leg counts DISTINCT lines). apply_patch-style edits with no
    # concrete path only set the .edited marker; they can't name a file.
    try:
        srcs = [p for p in ws_paths if is_product_source(p)]
        if srcs:
            with open(files_marker, 'a') as f:
                for p in srcs:
                    f.write(p + '\n')
    except Exception:
        pass
    sys.exit(0)


# ── Stop / SessionEnd: the per-turn nudge check ─────────────────────────────────
if name not in ('Stop', 'SessionEnd'):
    sys.exit(0)

# Cheap LOCAL short-circuits — no network on the common path.
if os.path.exists(done_marker):
    sys.exit(0)              # already nudged this session — stay quiet.
if not os.path.exists(edited_marker):
    sys.exit(0)              # no workspace edits this session — nothing to verify.


def call_tool(tool, args):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': tool, 'arguments': args}}).encode()
    req = urllib.request.Request(
        operator_url.rstrip('/') + '/api/mcp?superuser=1&origin=hook&client=' + urllib.parse.quote(sid, safe=''),
        data=body,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                 'Accept': 'application/json, text/event-stream'},
        method='POST')
    raw_resp = urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read().decode('utf-8', 'replace')
    result = None
    for line in raw_resp.splitlines():
        line = line.strip()
        if line.startswith('data:'):
            line = line[5:].strip()
        if not line:
            continue
        try:
            cand = json.loads(line)
            if isinstance(cand, dict) and 'result' in cand:
                result = cand['result']
                break
        except Exception:
            pass
    if not result or result.get('isError'):
        return None
    for item in (result.get('content') or []):
        if item.get('type') == 'text':
            try:
                return json.loads(item['text'])
            except Exception:
                pass
    return None


# Flag gate (DEFAULT ON): honor an explicit OFF; any error / unknown key → treat ON.
flag_fixture = os.environ.get('PAPERCUSP_WORKITEM_NUDGE_FLAG_FIXTURE')
if flag_fixture is not None:
    if flag_fixture.strip().lower() in ('0', 'off', 'false', 'no'):
        sys.exit(0)
else:
    try:
        fg = call_tool('flags:get', {'key': flag_key})
        if isinstance(fg, dict):
            results = fg.get('results') or []
            if results and results[0].get('ok') and results[0].get('enabled') is False:
                sys.exit(0)  # owner has flipped the backstop OFF.
    except Exception:
        pass  # fail-open → ON.

# Read the session objective: in-execution work-item title ?? declared coord intent.
glance_fixture = os.environ.get('PAPERCUSP_WORKITEM_NUDGE_GLANCE_FIXTURE')
glance = None
try:
    if glance_fixture:
        with open(glance_fixture) as f:
            glance = json.load(f)
    else:
        glance = call_tool('coord:glance', {'audience': 'user', 'activity_limit': 0})
except Exception:
    glance = None

# FAIL-OPEN: if we couldn't read the objective at all, do NOT nudge — we can't
# CONFIRM the session is objective-less. Only nudge on a confirmed-empty objective.
if not isinstance(glance, dict):
    sys.exit(0)
obj = (glance.get('self') or {}).get('objective')
has_objective = isinstance(obj, str) and bool(obj.strip())
multi_file_count = 0
if has_objective:
    # Standing-objective false-negative fix (agent-change-traceability P-002):
    # holding an objective (fleet lead / armed loop / monitor) is not registration
    # for THIS work — a session that edits many product-source files still gets ONE
    # verify-phrased nudge. Threshold keeps legit small in-objective edits silent.
    try:
        threshold = int(os.environ.get('PAPERCUSP_WORKITEM_NUDGE_MULTIFILE_THRESHOLD', '3') or '3')
    except Exception:
        threshold = 3
    if threshold <= 0:
        sys.exit(0)          # multi-file trigger disabled — objective covers it.
    distinct = set()
    try:
        with open(files_marker) as f:
            for line in f:
                line = line.strip()
                if line:
                    distinct.add(line)
    except Exception:
        pass
    multi_file_count = len(distinct)
    if multi_file_count < threshold:
        sys.exit(0)          # small edit under an objective — nothing to nudge.

# Best-effort prune of orphaned markers from long-dead sessions (bounded, once per
# nudging session). Keeps the lock-cache from accumulating stale wi-nudge-* files.
try:
    cutoff = time.time() - 24 * 3600
    for fn in os.listdir(cache_dir):
        if fn.startswith('wi-nudge-') and (fn.endswith('.edited') or fn.endswith('.done') or fn.endswith('.files')):
            fp = os.path.join(cache_dir, fn)
            try:
                if os.path.getmtime(fp) < cutoff:
                    os.remove(fp)
            except Exception:
                pass
except Exception:
    pass

# CONFIRMED: (no objective + edits) OR (objective + threshold-many product files)
# → emit ONE short reminder, phrased for the trigger that fired.
if has_objective:
    obj_short = obj.strip()[:120]
    msg = ('papercusp: you edited ' + str(multi_file_count) + ' distinct product-source files '
           'this session while holding the standing objective "' + obj_short + '" — VERIFY this '
           "work is registered: if it is not that objective's own scope, open a work-item for it "
           '(work_items:create, or claim a plan item).')
    activity_summary = ('edited ' + str(multi_file_count) + ' product files under a standing '
                        'objective — verify registration (multi-file backstop)')
else:
    msg = ('papercusp: you edited workspace code this session with no work-item or declared '
           'objective — open one (work_items:create, or claim a plan item) so the work is tracked.')
    activity_summary = 'edited code with no work-item — open one (verify backstop)'

# (1) durable local log line (audit trail; always safe).
try:
    with open(log_path, 'a') as f:
        f.write(now_iso() + ' [' + sid + '] ' + msg + '\n')
except Exception:
    pass

# (2) stderr (surfaces in the client hook transcript; never fed to the model on exit 0).
try:
    sys.stderr.write(msg + '\n')
except Exception:
    pass

# (3) best-effort coord NOTE into the cross-CLI activity bridge (pui fleet view +
# curator) — the same proven path the lifecycle / activity hooks use. The summary
# avoids the words start/end so activity:report derives no lifecycle phase. Skipped
# under a glance fixture (tests run offline).
if not glance_fixture:
    try:
        a = {'owner': sid, 'kind': 'lifecycle',
             'summary': activity_summary}
        if agent:
            a['agent'] = agent
        harness_slug = os.environ.get('PAPERCUSP_HARNESS_SLUG')
        if harness_slug:
            a['harness_slug'] = harness_slug
        sess = ev.get('session_id') or ev.get('sessionId')
        if isinstance(sess, str) and sess:
            a['session_id'] = sess
        cwd = ev.get('cwd')
        if isinstance(cwd, str) and cwd:
            a['cwd'] = cwd
        call_tool('activity:report', a)
    except Exception:
        pass

# Suppress further nudges this session (per-session de-dupe; per-turn evaluation).
try:
    with open(done_marker, 'w') as f:
        f.write(now_iso())
except Exception:
    pass

sys.exit(0)
PYEOF
}

if [ -n "${PAPERCUSP_WORKITEM_NUDGE_SYNC:-}" ]; then
  # Synchronous (tests / manual): suppress stdout (must stay empty) but let stderr
  # through so the reminder is visible / assertable.
  run >/dev/null || true
else
  # Detached fire-and-forget: reparent the work to init and release the hook's
  # stdout pipe immediately — zero added latency, operator slowness never blocks.
  ( run >/dev/null 2>&1 & ) >/dev/null 2>&1 || true
fi
exit 0
