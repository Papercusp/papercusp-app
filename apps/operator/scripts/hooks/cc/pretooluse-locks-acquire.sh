#!/usr/bin/env bash
# PreToolUse hook — claim SU-locks before a file edit. SHARED by Claude
# Code and Codex: both implement the same hook wire format (PreToolUse
# stdin with tool_name/tool_input/tool_use_id/session_id/cwd, and a
# `hookSpecificOutput.permissionDecision` decision contract).
#
# stdin (JSON) shapes we handle:
#   Claude:  { "tool_name": "Edit"|"Write"|"MultiEdit",
#              "tool_input": { "file_path": "..." }, ... }
#   Codex:   { "tool_name": "apply_patch",
#              "tool_input": <patch text or { ... patch text ... }>, ... }
#   Codex:   { "tool_name": "write_file",
#              "tool_input": { "path": "..." }, ... }
#
# Decision: we emit JSON on stdout. On contention we return
#   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
#       "permissionDecision": "deny", "permissionDecisionReason": "..." } }
# — `permissionDecisionReason` is fed back to the MODEL (on both clients),
# so the agent learns *why* and can retry/pivot/yield. (The deleted
# Claude shell hooks used exit-2 + stderr, which current clients surface
# to the user, not the model — so the agent never saw it. That is the
# one real modernization here.)
#
# On success we exit 0 with NO stdout — "no decision, proceed with the
# client's normal flow" — and cache the lock_id by tool_use_id so the
# matching PostToolUse hook can release only paths newly acquired by this
# edit. A same-owner already-held grant gets no release cache.
#
# Claude also sends transcript_path on PreToolUse. When the matching assistant
# message contains two or more native file-edit tool_use blocks, all of those
# edits are one client batch. The first hook atomically creates a batch state,
# acquires the union once, and followers consume the terminal state. Per-tool
# PostToolUse hooks see a .batch marker and defer release until the one
# PostToolBatch cleanup hook runs. Codex has no transcript batch path and keeps
# the original per-call lifecycle.
#
# Fail-open: if Papercusp isn't installed, or the operator is
# unreachable / unparseable, we ALWAYS allow the edit (cooperative
# discipline only works while the system is up) and drop a health
# marker so /coord can surface "enforcement offline".

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
# Managed sessions may receive either the operator origin or its full MCP
# endpoint. Normalize to the origin because the hook appends /api/mcp below.
OPERATOR_URL="${OPERATOR_URL%%/api/mcp*}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"
AGENT_ID_PATH="${HOME}/.papercusp/su-agent-id"
CACHE_DIR="${PAPERCUSP_LOCKS_CACHE_DIR:-${HOME}/.papercusp/locks-cache}"

# Bail out fast if Papercusp isn't installed — never break an edit for
# someone who hasn't run install-standalone-mcp.sh.
if [ ! -s "$TOKEN_PATH" ] || [ ! -s "$AGENT_ID_PATH" ]; then
  exit 0
fi

mkdir -p "$CACHE_DIR"
chmod 700 "$CACHE_DIR" 2>/dev/null || true

AGENT_ID=$(cat "$AGENT_ID_PATH")
INPUT=$(cat)

# Fail-open backstop: should the Python body ever exit non-zero from an
# error not caught inside (e.g. an OSError from realpath on a pathological
# path), ALLOW the edit rather than risk blocking it. The deny path emits
# its JSON then exits 0, so this guard only fires on an actual crash —
# never on a legitimate refusal.
python3 - "$OPERATOR_URL" "$TOKEN_PATH" "$AGENT_ID" "$CACHE_DIR" "$(dirname "$0")" 3<<<"$INPUT" <<'PYEOF' || { echo '[locks] hook error — allowing edit (fail-open)' >&2; exit 0; }
import hashlib, json, os, re, sys, time, urllib.request, urllib.parse
from datetime import datetime

operator_url, token_path, agent_id, cache_dir, hook_dir = sys.argv[1:6]
sys.path.insert(0, hook_dir)
from mcp_response import parse_mcp_response, read_hook_payload, read_token_file  # noqa: E402
raw = read_hook_payload()
token = read_token_file(token_path)


def write_marker(name, value):
    """Atomic-ish health marker write; never raises (a marker failure
    must not wedge the edit). Mirrors the OMP hook's markers so one
    /api/su-locks/hook-health endpoint serves every client."""
    try:
        path = os.path.join(cache_dir, name)
        tmp = path + '.tmp-' + str(os.getpid())
        with open(tmp, 'w') as f:
            f.write(json.dumps(value))
        os.replace(tmp, path)
    except Exception:
        pass


def mark_success():
    value = {'ts': now_iso()}
    write_marker('last-success.json', value)
    owner_value = globals().get('owner')
    if isinstance(owner_value, str) and owner_value:
        value['owner'] = owner_value
        write_marker(owner_marker_name('success'), value)


def mark_error(phase, detail):
    value = {
        'ts': now_iso(), 'handler': 'pretooluse', 'phase': phase,
        'detail': str(detail)[:200], 'operator_url': operator_url,
    }
    write_marker('last-error.json', value)
    owner_value = globals().get('owner')
    if isinstance(owner_value, str) and owner_value:
        value['owner'] = owner_value
        write_marker(owner_marker_name('error'), value)


def now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


compatibility_advisory = None


def allow():
    # A compatibility fallback may still allow the edit, but it must tell the
    # model that the first request hit a stale operator. Otherwise a successful
    # retry is indistinguishable from a healthy first attempt and the runtime
    # skew keeps widening silently.
    if compatibility_advisory:
        json.dump({'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'allow',
            'permissionDecisionReason': 'file-lock compatibility fallback (non-blocking)',
            'additionalContext': compatibility_advisory,
        }}, sys.stdout)
        sys.exit(0)
    # Exit 0, no stdout → no decision, client proceeds with normal flow.
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
    allow()  # Malformed input — never block.

tool_name = payload.get('tool_name', '') or ''
tool_input = payload.get('tool_input', {})
tool_use_id = payload.get('tool_use_id', '') or ''
cwd = payload.get('cwd') or os.getcwd()

# Identity: per-SESSION owner, NOT the machine-wide su-agent-id. The
# `-su` wrapper exports PAPERCUSP_SID (distinct per launch) AND bakes the
# same id into the interactive MCP `?client=`, so this hook and the
# agent's own coord/lock tool calls resolve to ONE owner — that's what
# lets a manual multi-file claim coexist with the per-edit hook instead
# of self-blocking. Fallbacks: the client's per-session session_id, then
# the machine-wide su-agent-id (two shells sharing only that collapse to
# one owner — the bug PAPERCUSP_SID fixes). Pre + Post share the env, so
# release still matches acquire.
env_sid = os.environ.get('PAPERCUSP_SID')
lock_sid = os.environ.get('PAPERCUSP_LOCK_SID')
session_id = payload.get('session_id')


def diagnostic_lock_sid():
    """Per-session CODEX_HOME is a second deterministic owner source. It lets
    an already-running Codex session pick up an identity repair even when Codex
    cached an older hook command/environment at launch."""
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
    """Owner-scoped runtime proof; the global marker remains for machine health."""
    safe = re.sub(r'[^A-Za-z0-9._-]', '_', owner)[:160] or 'unknown'
    return 'owner-' + safe + '-last-' + kind + '.json'


def patch_text(ti):
    """Codex apply_patch input may arrive as a raw string or wrapped in
    an object ({input|patch|...: <text>}). Be shape-robust: return any
    string content that looks like a patch."""
    if isinstance(ti, str):
        return ti
    if isinstance(ti, dict):
        for v in ti.values():
            if isinstance(v, str) and '*** ' in v:
                return v
        # Fall back: stringify the whole object and scan it.
        try:
            return json.dumps(ti)
        except Exception:
            return ''
    return ''


# ── Extract the file paths this tool will touch ────────────────────────
raw_paths = []
if tool_name in ('Edit', 'Write', 'MultiEdit'):
    fp = tool_input.get('file_path') if isinstance(tool_input, dict) else None
    if isinstance(fp, str) and fp:
        raw_paths.append(fp)
elif tool_name == 'apply_patch':
    # Patch headers: "*** Add File: p", "*** Update File: p",
    # "*** Delete File: p", and "*** Move to: p" (rename target).
    for m in re.finditer(r'^\*\*\* (?:Add|Update|Delete) File: (.+)$',
                         patch_text(tool_input), re.MULTILINE):
        raw_paths.append(m.group(1).strip())
    for m in re.finditer(r'^\*\*\* Move to: (.+)$',
                         patch_text(tool_input), re.MULTILINE):
        raw_paths.append(m.group(1).strip())
elif tool_name in ('write_file', 'edit_file'):
    p = tool_input.get('path') or tool_input.get('file_path') \
        if isinstance(tool_input, dict) else None
    if isinstance(p, str) and p:
        raw_paths.append(p)
else:
    allow()  # Not a file-editing tool.

if not raw_paths:
    allow()


# ── Claude native-batch identity ──────────────────────────────────────
# Claude invokes PreToolUse once per native tool_use, but several tool_use
# blocks from one assistant message may arrive concurrently.  The transcript
# is the only stable batch boundary exposed to this hook: locate the assistant
# JSONL entry containing the current tool_use_id and derive the batch from all
# native file-edit blocks in that entry.  Codex has no transcript_path on its
# apply_patch hook payload, so it keeps the per-call path set above.
EDIT_TOOL_NAMES = {'Edit', 'Write', 'MultiEdit'}
MAX_BATCH_TRANSCRIPT_BYTES = 4 * 1024 * 1024
batch_info = None
transcript_path = payload.get('transcript_path') or payload.get('transcriptPath') or ''


def _tool_use_blocks(entry):
    blocks = []
    message = entry.get('message') if isinstance(entry, dict) else None
    content = message.get('content') if isinstance(message, dict) else None
    if isinstance(content, list):
        blocks.extend(
            block for block in content
            if isinstance(block, dict) and block.get('type') == 'tool_use'
        )
    # A few transcript adapters flatten tool_use entries at the top level.
    if isinstance(entry, dict) and entry.get('type') == 'tool_use':
        blocks.append(entry)
    return blocks


def _block_paths(block):
    if not isinstance(block, dict) or block.get('name') not in EDIT_TOOL_NAMES:
        return []
    tool_input = block.get('input')
    if not isinstance(tool_input, dict):
        return []
    paths = []
    for key in ('file_path', 'path'):
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            paths.append(value)
            break
    # MultiEdit adapters sometimes expose the edits as a list while retaining
    # no top-level file_path.  Accept that shape only when every entry names a
    # file; an incomplete union must fall back to the safer per-call path set.
    if not paths and isinstance(tool_input.get('edits'), list):
        nested = []
        for edit in tool_input['edits']:
            if not isinstance(edit, dict):
                return []
            value = edit.get('file_path') or edit.get('path')
            if not isinstance(value, str) or not value:
                return []
            nested.append(value)
        paths.extend(nested)
    return paths


def _read_batch_descriptor(path, current_tool_id):
    """Return the transcript-derived native edit batch, or None when unknown."""
    if not isinstance(path, str) or not path or not isinstance(current_tool_id, str) or not current_tool_id:
        return None
    try:
        stat = os.stat(path)
        if stat.st_size > MAX_BATCH_TRANSCRIPT_BYTES:
            return None
        with open(path, 'rb') as transcript:
            raw_bytes = transcript.read()
    except Exception:
        return None

    # The current assistant entry is at the tail.  Drop a possibly torn first
    # line when a future transcript grows beyond this bounded read window.
    if len(raw_bytes) > MAX_BATCH_TRANSCRIPT_BYTES:
        raw_bytes = raw_bytes[-MAX_BATCH_TRANSCRIPT_BYTES:]
        raw_bytes = raw_bytes.split(b'\n', 1)[-1]
    for line in raw_bytes.splitlines():
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if not isinstance(entry, dict):
            continue
        blocks = _tool_use_blocks(entry)
        if not any(block.get('id') == current_tool_id for block in blocks):
            continue
        edit_blocks = [block for block in blocks if block.get('name') in EDIT_TOOL_NAMES]
        if len(edit_blocks) < 2:
            return None
        tool_ids = []
        paths = []
        for block in edit_blocks:
            block_id = block.get('id')
            block_paths = _block_paths(block)
            if not isinstance(block_id, str) or not block_id or not block_paths:
                return None
            tool_ids.append(block_id)
            paths.extend(block_paths)
        if current_tool_id not in tool_ids:
            return None
        canonical_transcript = os.path.realpath(path)
        batch_key = hashlib.sha256(
            (canonical_transcript + '\0' + '\0'.join(tool_ids)).encode('utf-8', 'replace')
        ).hexdigest()[:40]
        return {
            'batch_id': batch_key,
            'transcript_path': canonical_transcript,
            'tool_ids': tool_ids,
            'raw_paths': paths,
            'current_tool_id': current_tool_id,
        }
    return None


if transcript_path and tool_name in EDIT_TOOL_NAMES and tool_use_id:
    batch_info = _read_batch_descriptor(transcript_path, tool_use_id)
    if batch_info:
        # The rest of this hook applies foreign/worktree/symlink policy to the
        # complete union, not just the one tool whose hook happened to win the
        # race.  An incomplete or unreadable transcript deliberately leaves the
        # original per-call behavior intact.
        raw_paths = batch_info['raw_paths']


# ── P-109 leg (i): FOREIGN-WORKSPACE guard (p2p-work-distribution, design §2) ──
# Two registry-derived directional policies, evaluated by the operator
# (POST /api/su-locks/foreign-guard → lib/p2p/foreign-guard.ts):
#   - a FOREIGN-marked session (spawn-injected PAPERCUSP_FOREIGN_OFFER_ID +
#     PAPERCUSP_FOREIGN_SESSION_ID, minted by P-104, verified against the
#     p2p_foreign_workspaces row — never trusted alone) may edit ONLY its own
#     registered root. FAIL-CLOSED: no verdict ⇒ no edit.
#   - a HOST session must never edit under a registered foreign root (the C7
#     blending hazard inverted). Roots come from a 30s cache of the registry;
#     an unreachable operator fails OPEN here (matching the hook's global
#     posture — containment is P-105's job, this is honest-path policy).
def _foreign_guard_post(payload, mark=True):
    """POST to the foreign-guard route; parsed JSON dict or None on ANY failure.
    mark=False keeps a best-effort call (the host-direction cache refresh) from
    writing the error marker — fail-open paths stay quiet, the fail-CLOSED
    foreign-session path stays loud."""
    try:
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            operator_url.rstrip('/') + '/api/su-locks/foreign-guard',
            data=body,
            headers={'Authorization': 'Bearer ' + token,
                     'Content-Type': 'application/json'},
            method='POST',
        )
        # Never let an egress proxy intercept the localhost call (same reason
        # as the acquire call below).
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        resp = opener.open(req, timeout=6)
        out = json.loads(resp.read().decode('utf-8', errors='replace'))
        return out if isinstance(out, dict) else None
    except Exception as e:
        if mark:
            mark_error('foreign-guard', e)
        return None


_abs_paths = []
for _p in raw_paths:
    _ap = _p if os.path.isabs(_p) else os.path.join(cwd, _p)
    _abs_paths.append(os.path.abspath(_ap))

_foreign_offer = os.environ.get('PAPERCUSP_FOREIGN_OFFER_ID')
if _foreign_offer:
    # FOREIGN-marked session: one authoritative verdict per edit, FAIL-CLOSED.
    _v = _foreign_guard_post({
        'paths': _abs_paths,
        'offer_id': _foreign_offer,
        'session_id': os.environ.get('PAPERCUSP_FOREIGN_SESSION_ID', ''),
    })
    if not _v or _v.get('decision') != 'allow':
        _reason = _v.get('reason') if _v else None
        deny(_reason or (
            'foreign-work guard: refused — no guard verdict is reachable and this '
            f'session is foreign-marked (offer {_foreign_offer}). A foreign session '
            'edits nothing without a live registry verdict (fail-closed).'))
    # allow → fall through: a foreign clone lives outside the papercup
    # workspace, so the lock-scoping below skips it (nothing to lock).
else:
    # HOST session. Foreign roots live OUTSIDE the workspace root by the Q1
    # registration invariant, so only out-of-workspace paths can ever hit one
    # — in-workspace edits skip this check entirely (zero added latency on
    # the hot path).
    _ws_root = os.path.realpath(
        os.environ.get('PAPERCUSP_WORKSPACE_ROOT')
        or os.path.expanduser('~/papercupai-workspace'))
    _outside = [a for a in _abs_paths
                if not (os.path.realpath(a) == _ws_root
                        or os.path.realpath(a).startswith(_ws_root + os.sep))]
    # Cached foreign roots (30s TTL); on a hit, get the authoritative verdict
    # (which also bumps the P-004 counter). Refresh is best-effort: an
    # unreachable operator fails OPEN here.
    _roots = None
    if _outside:
        try:
            with open(os.path.join(cache_dir, 'foreign-roots.json')) as _f:
                _cached = json.load(_f)
            if time.time() - float(_cached.get('ts', 0)) < 30:
                _roots = _cached.get('roots')
        except Exception:
            pass
        if _roots is None:
            _v = _foreign_guard_post({'roots_only': True}, mark=False)
            _roots = _v.get('roots', []) if _v else []
            if _v is not None:
                write_marker('foreign-roots.json', {'ts': time.time(), 'roots': _roots})
    for _ap in _outside:
        _rap = os.path.realpath(_ap)
        _hit = None
        for _r in _roots or []:
            _root = _r.get('rootPath') if isinstance(_r, dict) else None
            if not _root:
                continue
            _rroot = os.path.realpath(_root)
            if _rap == _rroot or _rap.startswith(_rroot + os.sep):
                _hit = _r
                break
        if _hit is None:
            continue
        _v = _foreign_guard_post({'paths': _abs_paths})
        if _v and _v.get('decision') == 'allow':
            break  # registry moved on since the cache (row reaped) — fine.
        _reason = _v.get('reason') if _v else None
        deny(_reason or (
            f"foreign-work guard: refused — '{_ap}' is inside the FOREIGN "
            f"workspace of offer {_hit.get('offerId')} (root {_hit.get('rootPath')}). "
            'Host agents never edit foreign workspaces (C7): the foreign commit '
            'lane would attribute your work to the ORIGIN author.'))


def _valid_git_entry(d):
    """A `.git` entry only marks a repo root when VALID: a FILE (submodule /
    linked-worktree gitlink) or a DIR containing HEAD (every real git dir has
    one). A stray EMPTY `.git` dir (2026-07-13: an accidental `mkdir .git` at
    /tmp) must not re-key locks / red-pin tests — mirrors operator-core
    locks/valid-git-entry.ts (parity contract; keep in sync)."""
    g = os.path.join(d, '.git')
    if os.path.isfile(g):
        return True
    if os.path.isdir(g):
        return os.path.exists(os.path.join(g, 'HEAD'))
    return False


def find_repo_root(abs_path):
    """Walk up from a file (or its nearest existing parent) to the dir
    holding a VALID `.git` entry — gitlink file (worktree) or git dir with
    HEAD. Returns the repo root or None. Deriving the root per-edit keeps
    the hook correct across the many worktrees in this workspace (a
    hardcoded root would mis-key locks in every checkout but one)."""
    d = abs_path
    if not os.path.isdir(d):
        d = os.path.dirname(d)
    while d and d != '/':
        if _valid_git_entry(d):
            return d
        d = os.path.dirname(d)
    return None


def _repo_git_config_path(repo_root):
    """Absolute path to a repo's `config` for ANY repo shape — ordinary clone
    (`.git` dir), linked worktree (`.git` file → gitdir → commondir), or
    submodule (`.git` file → gitdir with its own config). None when it cannot
    be resolved. Split out of _repo_origin_url so the remote-less check below
    reads the SAME config by the SAME rules — the two must never disagree
    about which file they judged."""
    git_entry = os.path.join(repo_root, '.git')
    if os.path.isfile(git_entry):
        with open(git_entry) as f:
            m = re.match(r'gitdir:\s*(.+)$', f.read().strip())
        if not m:
            return None
        gd = m.group(1).strip()
        if not os.path.isabs(gd):
            gd = os.path.join(repo_root, gd)
        gd = os.path.realpath(gd)
        cfg = os.path.join(gd, 'config')
        if not os.path.exists(cfg):
            # Linked worktree: config lives in the COMMON git dir.
            cd_path = os.path.join(gd, 'commondir')
            if not os.path.exists(cd_path):
                return None
            with open(cd_path) as f:
                cd = f.read().strip()
            if not os.path.isabs(cd):
                cd = os.path.join(gd, cd)
            cfg = os.path.join(os.path.realpath(cd), 'config')
        return cfg
    return os.path.join(git_entry, 'config')


def _repo_origin_url(repo_root):
    """Best-effort `origin` fetch URL for ANY repo shape. None on ANY
    failure (unreadable, no origin remote, broken gitdir). Used by the
    worktree guard (WI-5031) to tell a stray checkout of the CANONICAL
    project apart from an independent repo that merely lives in the
    workspace dir. Parses .git/config directly — no `git` subprocess on
    the per-edit hot path."""
    try:
        cfg = _repo_git_config_path(repo_root)
        if cfg is None:
            return None
        url, in_origin = None, False
        with open(cfg) as f:
            for line in f:
                s = line.strip()
                if s.startswith('['):
                    in_origin = re.sub(r'\s+', '', s) == '[remote"origin"]'
                elif in_origin and s.split('=', 1)[0].strip() == 'url':
                    url = s.split('=', 1)[1].strip() if '=' in s else None
                    break
        return url or None
    except Exception:
        return None


def _repo_has_zero_remotes(repo_root):
    """True when the repo's config was READ SUCCESSFULLY and declares NO
    remotes at all; False when it declares at least one; None when the config
    could not be read.

    EI-18825797177551487 — why this exists, and why it is sound. WI-5031 made
    an independent sibling exempt from the worktree guard, but used `origin` as
    the independence proof and treated an UNREADABLE-or-ABSENT origin as
    "not proven independent" (deny). That conflates two very different repos:
    one we could not read, and one that provably has no remote at all.

    A stray checkout of the canonical project is, by construction, a CLONE — so
    it always carries an origin. A repo declaring zero remotes was never cloned
    from anything and therefore cannot be a stray checkout of the canonical
    tree, which is the only hazard this guard exists to prevent. Verified
    against every sibling in this workspace when the fix was written: the
    same-project checkouts (papercup-checkpoint, papercup-release,
    papercusp-checkpoint, papercusp-staging) carry
    origin=.../papercup.git, while every remote-less sibling (hive-canary — a
    REGISTERED harness with its own `auto-commit hive-canary` git-sync lane —
    plus brood-box-alpha and the greenfield-* project trees) is a genuinely
    independent local project. Denying those parked the daily loop-health
    canary as unworkable, the same failure mode WI-5031 was written to fix.

    Deliberately distinguishes "read it, found none" from "could not read":
    only the former proves independence. Unreadable still denies.

    ⚠ Do NOT read that sibling list as "every papercup* directory is a checkout
    the origin test refuses". Two of them are SYMLINKS and reach neither this
    function nor the origin comparison: `papercup` -> `papercusp` IS the canonical
    tree (edits through it are correctly ALLOWED — realpath normalizes them), and
    `papercusp-release` -> `papercup-release`. The rest are LINKED WORKTREES,
    refused earlier by the commondir branch. An earlier revision of this list
    named `papercup` among the refused checkouts, which reads as a guard hole the
    moment you observe an edit there succeed — it cost a bogus major-severity bug
    filing (EI-18826235967595309). Enumerate the shapes before believing any
    summary of them, this one included."""
    try:
        cfg = _repo_git_config_path(repo_root)
        if cfg is None:
            return None
        saw_remote = False
        with open(cfg) as f:
            for line in f:
                s = line.strip()
                if s.startswith('[') and re.match(r'\[remote\s*"', re.sub(r'\s+', ' ', s)):
                    saw_remote = True
                    break
        return not saw_remote
    except Exception:
        return None


def _norm_origin(url):
    """Normalize remote-URL spellings to `host/path` so ssh and https forms
    of the SAME remote compare equal (git@github.com:Org/repo.git ≡
    https://github.com/Org/repo). None in → None out."""
    if not url:
        return None
    u = url.strip().rstrip('/')
    if u.lower().endswith('.git'):
        u = u[:-4]
    m = re.match(r'^(?:git@|ssh://(?:git@)?|https?://|git://)([^/:]+)[:/](.*)$', u)
    return (m.group(1) + '/' + m.group(2)).lower() if m else u.lower()


def _origin_is_local_path_into_canonical(url, repo_root, canonical_tree,
                                        canon_origin_norm):
    """True when `url` is a LOCAL FILESYSTEM origin that points AT the canonical
    project — the same-project checkout `_norm_origin` structurally cannot see.

    EI-18826235967595309. WI-5031's independence test compares NORMALIZED REMOTE
    URLS, which quietly assumes every checkout of the canonical project was cloned
    from the same forge URL. A tree cloned from a SIBLING PATH
    (`git clone ../papercup runner`) records origin=/abs/path; that normalizes to
    the path itself and so never equals the canonical tree's
    `github.com/papercusp/papercup`. `_origins_differ` therefore computed True and
    the guard ALLOWED edits inside a full checkout of the canonical project, which
    is precisely the stranding hazard it exists to refuse.

    Verified live when this was written: `papercup-improvement-runner` is exactly
    this shape — origin `<ws>/papercup`, itself a symlink to `<ws>/papercusp` — and
    it was holding 22 uncommitted files that git-sync will never commit.

    Resolves ONE hop, deliberately: the path itself (a clone of the canonical
    tree), and a clone-of-a-clone whose own origin is the canonical forge URL.
    Anything unresolvable returns False, which keeps this strictly ADDITIVE — it
    can only catch checkouts the URL comparison already missed, and can never
    newly refuse an independent sibling."""
    if not url:
        return False
    try:
        p = url.strip()
        if p.startswith('file://'):
            p = p[len('file://'):]
        elif re.match(r'^(?:git@|ssh://|https?://|git://)', p):
            return False  # a genuine remote URL — _norm_origin already decided it
        if not os.path.isabs(p):
            # git records `clone ../sibling` verbatim; resolve it against the
            # cloned repo, which is the base git itself uses.
            p = os.path.join(repo_root, p)
        real = os.path.realpath(p)
        if os.path.basename(real) == '.git':
            real = os.path.dirname(real)
        if real == canonical_tree:
            return True
        nested = _norm_origin(_repo_origin_url(real))
        return (nested is not None and canon_origin_norm is not None
                and nested == canon_origin_norm)
    except Exception:
        return False


# Scope enforcement to the papercup workspace. Its worktrees (papercup,
# papercup-<topic>, …) are direct children of WORKSPACE_ROOT. We compute
# lock keys as paths RELATIVE TO each worktree root, so the same logical
# file collides across worktrees AND with the OMP hook (which keys the
# same way) — that's the cross-client/cross-worktree contention we want.
# A non-repository file below the current user's HOME or XDG_RUNTIME_DIR is
# mapped to a reserved logical key. This coordinates shared desktop/config and
# runtime credential edits (mimeapps.list, KDE settings, agent config,
# Playwright storage state) without weakening the server's no-absolute-path
# lock-store contract. Other repos and paths outside those roots stay
# unguarded.
workspace_root = os.path.realpath(
    os.environ.get('PAPERCUSP_WORKSPACE_ROOT')
    or os.path.expanduser('~/papercupai-workspace')
)


def _path_is_within(path, parent):
    """Whether a canonical path is equal to or below another path."""
    return path == parent or path.startswith(parent + os.sep)


def _workspace_repo_root(repo_root):
    """Find the direct workspace repo containing a nested repo root.

    A submodule has its own `.git` entry, so find_repo_root returns the
    submodule rather than the enclosing staging checkout. The enclosing
    direct-child repo still owns worktree policy; unrelated repos outside the
    workspace (and arbitrary nested repos below them) remain out of scope.
    """
    candidate = os.path.realpath(repo_root)
    if (candidate == workspace_root
            or not _path_is_within(candidate, workspace_root)):
        return None
    while os.path.dirname(candidate) != workspace_root:
        parent = os.path.dirname(candidate)
        if parent == candidate or not _path_is_within(parent, workspace_root):
            return None
        candidate = parent
    return candidate if _valid_git_entry(candidate) else None


def _managed_suite_app_repo(repo_root):
    """Whether this is a workspace-owned suite app checkout.

    Portal, email, calendar, phone, and future suite apps are separate Git
    repositories materialized at
    ``~/.papercusp-workspaces/<workspace>/.papercusp/apps/<app>``. They are not
    children of ``PAPERCUSP_WORKSPACE_ROOT``, but they are managed edit trees,
    not arbitrary hidden-home configuration. Key them by physical repository
    domain so a deliberate ``locks:acquire { coordination_domain, paths }``
    and the automatic edit guard serialize on the same lock.
    """
    try:
        workspaces_root = os.path.realpath(
            os.environ.get('PAPERCUSP_WORKSPACES_ROOT')
            or os.path.expanduser('~/.papercusp-workspaces'))
        rel = os.path.relpath(os.path.realpath(repo_root), workspaces_root)
        parts = rel.split(os.sep)
        return (len(parts) == 4
                and parts[0] not in ('', '.', '..')
                and parts[1] == '.papercusp'
                and parts[2] == 'apps'
                and parts[3] not in ('', '.', '..')
                and _valid_git_entry(repo_root))
    except Exception:
        return False


def _is_isolation_worktree(repo_root, canonical_tree):
    """Migration/synthesis isolation worktrees stay outside automatic locks."""
    marker = os.path.join(canonical_tree, '.papercusp', 'worktrees')
    return _path_is_within(os.path.realpath(repo_root), marker)

# ── Resolve to repo-relative POSIX, refuse symlinked paths ─────────────
repo_relative = []
repo_domains = set()


def _external_lock_key(abs_path):
    """Map current-user HOME/runtime files to the shared external keyspace.

    A user's HOME may itself be a git repo, so this check cannot depend on
    find_repo_root returning None. Keep automatic HOME scope to dot-directories;
    an unrelated ~/project repo stays outside Papercusp coordination. Runtime
    files are scoped to the current user's XDG_RUNTIME_DIR (or Linux's
    /run/user/<uid> fallback) and may use any relative path beneath it.
    Explicit locks:acquire external_paths uses the same roots server-side.
    """
    try:
        runtime_root = os.environ.get('XDG_RUNTIME_DIR', '').strip()
        if not runtime_root and sys.platform == 'linux':
            getuid = getattr(os, 'getuid', None)
            if getuid is not None:
                runtime_root = f'/run/user/{getuid()}'
        if runtime_root and os.path.isabs(runtime_root):
            runtime_root = os.path.realpath(runtime_root)
            logical_abs = os.path.abspath(abs_path)
            rel_runtime = os.path.relpath(logical_abs, runtime_root)
            if (rel_runtime and rel_runtime != '..'
                    and not rel_runtime.startswith('..' + os.sep)
                    and not os.path.isabs(rel_runtime)):
                return '@external/runtime/' + rel_runtime.replace(os.sep, '/')

        home_root = os.path.realpath(
            os.environ.get('PAPERCUSP_EXTERNAL_LOCK_HOME')
            or os.path.expanduser('~'))
        logical_abs = os.path.abspath(abs_path)
        rel_home = os.path.relpath(logical_abs, home_root)
        first = rel_home.split(os.sep, 1)[0]
        if (rel_home and rel_home != '..'
                and not rel_home.startswith('..' + os.sep)
                and not os.path.isabs(rel_home)
                and first.startswith('.')):
            return '@external/home/' + rel_home.replace(os.sep, '/')
    except Exception:
        pass
    return None


for p in raw_paths:
    abs_p = p if os.path.isabs(p) else os.path.join(cwd, p)
    abs_p = os.path.abspath(abs_p)

    root = find_repo_root(abs_p)
    if not root:
        _external_key = _external_lock_key(abs_p)
        if _external_key:
            repo_relative.append(_external_key)
        continue  # Outside a repo and outside HOME remains uncoordinated.

    # ── Worktree discipline: only the canonical staging tree is editable ──
    # The shared staging tree (papercusp) is the ONE tree agents edit — its
    # changes are what git-sync auto-commits + deploys. A stray sibling
    # worktree (papercup-staging, papercup-release, papercup-checkpoint,
    # papercusp-staging, old feature worktrees) is a direct child of the
    # workspace root just like the canonical tree, but work left in one never
    # reaches the committed tree (it stranded a whole feature on 2026-06-30).
    # Refuse edits in any such sibling. Isolation worktrees created by the
    # migration/synthesis roles live under <tree>/.papercusp/worktrees/, whose
    # parent is NOT the workspace root, so they pass through; foreign repos
    # outside the workspace are likewise unaffected. See plan
    # worktree-discipline-single-tree-enforcement-2026-06-30.
    #
    # EI-8820: the sibling-of-workspace-root check above only catches a
    # linked worktree that lives as a DIRECT CHILD of workspace_root. A
    # linked worktree of the canonical repo can be registered ANYWHERE
    # (e.g. ~/.papercusp-workspaces/<ws>/.papercusp/env-trees/<name> — a
    # per-workspace ephemeral checkout `git worktree add`-ed from the
    # canonical tree) and that shape slips past the parent-dir test
    # entirely, then hits the `continue` below as an unrelated "foreign"
    # repo — so edits there were silently ALLOWED and never git-sync
    # committed (a live repro stranded 6 edits + 1 write for 4+ ticks).
    # Catch it structurally instead of by location: a linked worktree's
    # `.git` is a FILE (`gitdir: .../worktrees/<name>`), not a directory;
    # resolve it through `commondir` to the real main repo's `.git`, and
    # if THAT main repo is the canonical tree, this worktree is exactly
    # as off-limits as a sibling one — no matter where on disk it sits.
    def _resolve_worktree_main_root(repo_root):
        """None if repo_root is an ordinary repo (its `.git` is a dir) or
        resolution fails for any reason (fail-open); else the main repo's
        working-tree root that this LINKED worktree belongs to."""
        try:
            git_entry = os.path.join(repo_root, '.git')
            if not os.path.isfile(git_entry):
                return None  # ordinary repo dir, or no .git at all
            with open(git_entry) as f:
                m = re.match(r'gitdir:\s*(.+)$', f.read().strip())
            if not m:
                return None
            wt_gitdir = m.group(1).strip()
            if not os.path.isabs(wt_gitdir):
                wt_gitdir = os.path.join(repo_root, wt_gitdir)
            wt_gitdir = os.path.realpath(wt_gitdir)
            commondir_path = os.path.join(wt_gitdir, 'commondir')
            if not os.path.exists(commondir_path):
                return None
            with open(commondir_path) as f:
                commondir = f.read().strip()
            if not os.path.isabs(commondir):
                commondir = os.path.join(wt_gitdir, commondir)
            main_git_dir = os.path.realpath(commondir)
            return os.path.dirname(main_git_dir)
        except Exception:
            return None  # fail-open — never wedge an edit on a parse error

    def _resolve_enclosing_worktree(repo_root):
        """Return (linked_root, main_root) for an enclosing linked worktree.

        `find_repo_root` stops at the nearest repository, which can be a
        submodule nested inside the worktree we must refuse. Walk ancestors so
        worktree policy follows the enclosing checkout and is independent of
        where that checkout is registered on disk.
        """
        try:
            candidate = os.path.realpath(repo_root)
            while candidate and candidate != os.path.dirname(candidate):
                main_root = _resolve_worktree_main_root(candidate)
                if main_root is not None:
                    return candidate, main_root
                candidate = os.path.dirname(candidate)
        except Exception:
            pass
        return None, None

    _canonical_tree = os.path.realpath(
        os.environ.get('PAPERCUSP_CANONICAL_TREE')
        or os.path.join(workspace_root, 'papercusp'))
    _real_root = os.path.realpath(root)
    _linked_root, _wt_main = _resolve_enclosing_worktree(root)
    if (_linked_root is not None
            and _wt_main is not None
            and os.path.realpath(_wt_main) == _canonical_tree
            and os.path.realpath(_linked_root) != _canonical_tree
            and not _is_isolation_worktree(_linked_root, _canonical_tree)):
        deny(
            f"worktree guard: refused — '{_linked_root}' is a LINKED WORKTREE of "
            f"the canonical staging tree ({_canonical_tree}), registered "
            f"outside it. Agents edit ONLY the canonical tree itself; work "
            f"left in any of its linked worktrees is never committed by "
            f"git-sync (it silently strands). cd into the canonical tree "
            f"and make this edit there."
        )
    _scope_root = None
    _scope_real = None
    try:
        _scope_root = _workspace_repo_root(root)
        if _scope_root is None and _managed_suite_app_repo(root):
            _scope_root = root
        if _scope_root is None:
            _external_key = _external_lock_key(abs_p)
            if _external_key:
                repo_relative.append(_external_key)
            continue  # Outside a workspace worktree remains uncoordinated.
        _scope_real = os.path.realpath(_scope_root)
        if _is_isolation_worktree(root, _canonical_tree):
            continue  # Preserve migration/synthesis isolation semantics.

        # The hook may call an operator serving a DIFFERENT checkout than the
        # one being edited (normally :3070's release tree vs the canonical
        # staging tree). Preserve the physical repo root so locks:acquire keys
        # the same domain as this edit instead of the operator process's own
        # checkout.
        repo_domains.add(_real_root)

        # Worktree policy belongs to the enclosing direct-child repo, not a
        # nested submodule's own `.git` entry. A linked submodule is not a
        # linked worktree, while a submodule inside a stray linked worktree
        # must still be refused as part of that enclosing tree.
        if (_scope_real != _canonical_tree
                and os.path.realpath(os.path.dirname(_scope_root)) == workspace_root):
            # WI-5031: a sibling is only a stranding hazard when it is a
            # checkout of the SAME project as the canonical tree (papercup-
            # release, papercup-checkpoint, old feature clones) — git-sync
            # commits only the canonical tree, so work left in those dies.
            # An INDEPENDENT repo that merely lives in the workspace dir
            # (papercup-rust-mobile: own .git, own remote, own commit
            # discipline) is legitimate to edit; denying it parked the whole
            # mobile release campaign as needs-human. Deny only when the
            # sibling's origin remote matches the canonical tree's, or when
            # either origin is unreadable (conservative: an unprovable
            # sibling keeps the old refusal).
            _sib_origin_raw = _repo_origin_url(_scope_root)
            _sib_origin = _norm_origin(_sib_origin_raw)
            _canon_origin = _norm_origin(_repo_origin_url(_canonical_tree))
            # Independent by EITHER proof:
            #  (a) both origins readable and DIFFERENT (WI-5031's original test), or
            #  (b) the sibling provably declares NO remotes — never cloned, so it
            #      cannot be a stray checkout of the canonical project
            #      (EI-18825797177551487; see _repo_has_zero_remotes).
            # Unproven in both directions still denies — the conservative default.
            #
            # (a) carries one blind spot: "different URL" is not "different
            # project" when the URL is a LOCAL PATH pointing back at the canonical
            # tree (EI-18826235967595309 — see
            # _origin_is_local_path_into_canonical). Such a sibling is a
            # same-project checkout wearing an unrecognizable origin, so it must
            # not earn independence from the mere string difference.
            _origins_differ = (_sib_origin is not None
                               and _canon_origin is not None
                               and _sib_origin != _canon_origin
                               and not _origin_is_local_path_into_canonical(
                                   _sib_origin_raw, _scope_root, _canonical_tree,
                                   _canon_origin))
            if not (_origins_differ or _repo_has_zero_remotes(root) is True):
                deny(
                    f"worktree guard: refused — you are editing in '{root}', which "
                    f"is not the canonical staging tree. Agents edit ONLY the shared "
                    f"staging tree ({_canonical_tree}); other worktrees are off-limits "
                    f"because work left in them never reaches the auto-committed tree. "
                    f"cd into the staging tree and make this edit there. (An "
                    f"INDEPENDENT sibling repo is exempt — one whose `origin` remote "
                    f"provably differs from the canonical tree's, OR which provably "
                    f"declares no remotes at all. This tree's origin matches the "
                    f"canonical project, or is a LOCAL PATH that resolves to it "
                    f"(a `git clone ../papercup` checkout — same project, different "
                    f"origin spelling), or its git config could not be read.)"
                )
    except Exception:
        pass  # The guard must never wedge an edit on its own error (fail-open).

    if _scope_root is None or _scope_real is None:
        _external_key = _external_lock_key(abs_p)
        if _external_key:
            repo_relative.append(_external_key)
        continue  # Outside a workspace worktree remains uncoordinated.

    # A nested repo inside an independent direct-child project remains that
    # project's concern; only nested repos in the canonical staging tree are
    # part of this automatic lock domain. Direct-child independent repos keep
    # their existing normal lock behavior.
    if _scope_real != _real_root and _scope_real != _canonical_tree:
        _external_key = _external_lock_key(abs_p)
        if _external_key:
            repo_relative.append(_external_key)
        continue

    rel = os.path.relpath(abs_p, root)
    if rel.startswith('..'):
        continue  # Escapes the repo — not coordinated.

    # Symlink refusal (mirrors the OMP hook). The lock store keys on the
    # path STRING, so a symlink alias and its target are two keys — two
    # agents could "edit the same file" through different names and both
    # acquire. We run ON the agent's filesystem (the operator doesn't),
    # so we can catch it. REFUSE rather than silently rewrite to the
    # canonical path (rewriting would hide the aliasing from the agent).
    try:
        real_root = os.path.realpath(root)
        # For a not-yet-existent leaf (new file), realpath its parent so
        # a symlinked *directory* component is still caught.
        target = abs_p if os.path.exists(abs_p) else os.path.dirname(abs_p)
        real_rel = os.path.relpath(os.path.realpath(target), real_root)
        logical_rel = rel if os.path.exists(abs_p) else os.path.dirname(rel)
        if real_rel != (logical_rel or '.'):
            deny(
                f"locks: refused — '{rel}' resolves through a symlink "
                f"(real path '{real_rel}'). Edit the canonical path "
                f"directly so the lock keys on one name."
            )
    except Exception:
        pass  # realpath failure (broken link, EACCES) → leave to server.

    repo_relative.append(rel)

if not repo_relative:
    allow()

# Dedupe, keep order. Do this explicitly rather than using a truthiness-based
# list-comprehension idiom: set.add() returns the set (truthy), so
# `not (x in seen or seen.add(x))` drops every first occurrence and emits the
# invalid `paths: []` request shape.
seen = set()
deduped_repo_relative = []
for x in repo_relative:
    if x in seen:
        continue
    seen.add(x)
    deduped_repo_relative.append(x)
repo_relative = deduped_repo_relative


# ── Claude batch election/state ────────────────────────────────────────
# The hooks are separate short-lived processes, so the batch barrier lives in
# the shared cache directory.  O_CREAT|O_EXCL elects exactly one leader; its
# terminal state is atomically replaced after the union acquire.  Followers
# never call locks:acquire themselves, which is the property that prevents a
# parallel Claude batch from being partially admitted.
batch_role = None
batch_terminal = None


def _batch_path(suffix):
    return os.path.join(cache_dir, 'batch-' + batch_info['batch_id'] + suffix)


def _batch_write_json(path, value):
    try:
        tmp = path + '.tmp-' + str(os.getpid())
        with open(tmp, 'w') as f:
            json.dump(value, f)
        os.replace(tmp, path)
        return True
    except Exception:
        try:
            os.remove(tmp)
        except Exception:
            pass
        return False


def _batch_read_state():
    if not batch_info:
        return None
    try:
        with open(_batch_path('.state.json')) as f:
            state = json.load(f)
        if (isinstance(state, dict)
                and state.get('batch_id') == batch_info['batch_id']):
            return state
    except Exception:
        pass
    return None


def _batch_claim_is_stale():
    try:
        with open(_batch_path('.leader')) as f:
            claim = json.load(f)
        pid = claim.get('pid') if isinstance(claim, dict) else None
        if isinstance(pid, int) and pid > 0:
            try:
                os.kill(pid, 0)
                return False
            except ProcessLookupError:
                return True
            except PermissionError:
                return False
        started = claim.get('started_at') if isinstance(claim, dict) else None
        return not isinstance(started, (int, float)) or time.time() - started > 30
    except FileNotFoundError:
        return True
    except Exception:
        return False


def _batch_try_elect():
    if not batch_info:
        return False
    path = _batch_path('.leader')
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump({
                'batch_id': batch_info['batch_id'],
                'pid': os.getpid(),
                'owner': owner,
                'started_at': time.time(),
            }, f)
        return True
    except FileExistsError:
        return False
    except Exception:
        return False


def _batch_mark_tool(status):
    if not batch_info or not tool_use_id:
        return
    marker = {
        'batch_id': batch_info['batch_id'],
        'tool_use_id': tool_use_id,
        'transcript_path': batch_info['transcript_path'],
        'status': status,
        'owner': owner,
    }
    _batch_write_json(os.path.join(cache_dir, tool_use_id + '.batch'), marker)


def _batch_terminal_state(status, **extra):
    if not batch_info:
        return False
    state = {
        'version': 1,
        'batch_id': batch_info['batch_id'],
        'status': status,
        'transcript_path': batch_info['transcript_path'],
        'tool_use_ids': batch_info['tool_ids'],
        'paths': repo_relative[:100],
        'owner': owner,
        'updated_at': time.time(),
    }
    state.update(extra)
    return _batch_write_json(_batch_path('.state.json'), state)


def _batch_wait_for_terminal():
    """Wait for the elected leader, or take over only after it is gone."""
    deadline = time.time() + 20
    while time.time() < deadline:
        state = _batch_read_state()
        if state and state.get('status') in ('granted', 'allowed', 'denied'):
            return 'follower', state
        if _batch_claim_is_stale():
            try:
                os.remove(_batch_path('.leader'))
            except FileNotFoundError:
                pass
            except Exception:
                pass
            if _batch_try_elect():
                _batch_terminal_state(
                    'running', leader_pid=os.getpid(), started_at=time.time(),
                )
                return 'leader', None
        time.sleep(0.03)
    return 'timeout', None


def _batch_prepare():
    if not batch_info:
        return None, None
    state = _batch_read_state()
    if state and state.get('status') in ('granted', 'allowed', 'denied'):
        return 'follower', state
    if _batch_try_elect():
        if not _batch_terminal_state(
                'running', leader_pid=os.getpid(), started_at=time.time()):
            try:
                os.remove(_batch_path('.leader'))
            except Exception:
                pass
            return 'timeout', None
        return 'leader', None
    return _batch_wait_for_terminal()


def _batch_consume(state):
    if not isinstance(state, dict):
        deny('locks: batch state was unavailable; retry the complete Claude edit batch.')
    status = state.get('status')
    _batch_mark_tool(status)
    if status in ('granted', 'allowed'):
        write_marker('last-decision.json', {
            'ts': now_iso(),
            'decision': 'batch-follower-' + status,
            'owner': owner,
            'tool': tool_name,
            'paths': repo_relative[:50],
            'batch_id': batch_info['batch_id'],
        })
        try:
            os.remove(os.path.join(cache_dir, owner_marker_name('transient-streak')))
        except Exception:
            pass
        allow()
    deny(state.get('reason') or 'locks: the Claude edit batch was denied; retry the complete batch.')


if batch_info:
    batch_info['paths'] = repo_relative[:100]
    batch_info['domains'] = sorted(repo_domains)
    batch_role, batch_terminal = _batch_prepare()
    if batch_role == 'follower':
        _batch_consume(batch_terminal)
    if batch_role == 'timeout':
        deny(
            'locks: Claude edit batch leader did not publish a terminal decision. '
            'No partial edit is permitted; retry the complete batch.'
        )

# ── Acquire (no server-side wait: block immediately so the agent can
#    replan now rather than hang the edit). ──────────────────────────────
lock_arguments = {
    'paths': repo_relative,
    'intent': f'PreToolUse:{tool_name}',
    'ttl_sec': 1200,
    'wait': {'max_sec': 0},
}
if len(repo_domains) == 1:
    lock_arguments['coordination_domain'] = next(iter(repo_domains))


def _make_tool_request(name, arguments):
    # format=json: the MCP result-format default flipped to compact (TOON-rendered
    # text); this hook json.loads the tool result, so it MUST request json or the
    # parse fails and lock protection silently drops (fail-open).
    body = json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
        'params': {'name': name, 'arguments': arguments},
    }).encode()
    return urllib.request.Request(
        operator_url.rstrip('/') + '/api/mcp?superuser=1&origin=hook&format=json&client='
        + urllib.parse.quote(owner, safe=''),
        data=body,
        headers={
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        },
        method='POST',
    )


def _make_request(arguments):
    return _make_tool_request('locks:acquire', arguments)


req = _make_request(lock_arguments)
req_without_coordination_domain = None
if 'coordination_domain' in lock_arguments:
    fallback_arguments = dict(lock_arguments)
    del fallback_arguments['coordination_domain']
    req_without_coordination_domain = _make_request(fallback_arguments)


def _coordination_domain_rejection(value):
    """Return a short error detail when an older operator rejects the new arg.

    The MCP endpoint normally returns this as a JSON-RPC ``error`` object, but
    some older dispatch paths wrap the same text in a successful result's
    content. Keep the compatibility match deliberately narrow: only an
    invalid/unrecognized ``coordination_domain`` key may trigger the fallback;
    other invalid-input errors must retain the normal fail-open behavior.
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


def _is_conn_refused(exc):
    # The :3070 host has no hot-reload, so picking up a lib/** edit means a
    # RESTART; during that few-second boot the port REFUSES connections. That
    # is the one transient worth retrying — distinguish it from a genuinely
    # down operator (which should still fail open promptly).
    if isinstance(exc, ConnectionRefusedError):
        return True
    if isinstance(getattr(exc, 'reason', None), ConnectionRefusedError):
        return True
    s = str(exc)
    return 'Connection refused' in s or 'Errno 111' in s

# Bounded retry on connection-refused so a short restart window doesn't drop
# lock protection for every concurrent agent (single-shot used to fail open
# instantly). ~2.4s max added delay, then fail open as before. Any non-refused
# error fails open immediately (no point waiting on a 500 / parse error).
RETRY_BACKOFFS = (0.4, 0.8, 1.2)
# The operator is ALWAYS local (127.0.0.1/localhost); an egress http(s)_proxy in
# the env must NEVER intercept this call — it 502s the localhost POST, which the
# loop below would treat as "operator unreachable" and fail OPEN, silently
# dropping file-lock protection for every concurrent agent (and reds the
# pretooluse-locks-decision gate test). Bypass all proxies for the operator call.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _best_effort_tool(name, arguments, timeout=3):
    """Call a recovery tool without retrying or changing the hook decision."""
    try:
        resp = _opener.open(_make_tool_request(name, arguments), timeout=timeout)
        raw_resp = resp.read().decode('utf-8', errors='replace')
    except Exception as exc:
        return None, None, 'transport', exc
    inner, rpc_error, phase = parse_mcp_response(raw_resp)
    return inner, rpc_error, phase, None


# EI-22176521893516708 — orphaned-claim reconcile.
#
# Several PreToolUse hooks share this hook's matcher (control-bytes, secrets,
# content-lint, the migration/generated-file guards). We claim the lock; one of
# THEM can then DENY the call. A denied tool call never reaches PostToolUse, so
# the release that would have run does not, and the lock we just took is held
# for its full TTL (20min) over a write that never happened. git-sync excludes
# every actively-locked path from its sweep, so that path silently misses every
# tick until the TTL lapses — which can leave a change half-landed (a committed
# test importing a module still sitting untracked). The guards are working as
# designed and a refusal is an expected outcome; the INTERACTION is the defect.
#
# A hook cannot observe another hook's verdict, so we do not try to detect the
# deny. We reconcile instead: on every run, sweep cache entries whose PostToolUse
# demonstrably never arrived. That covers the whole class — any guard, any deny
# reason, any tool — and self-heals the reported case, where the agent's own
# retry was blocked by the orphan its blocked attempt had just created.
#
# ⚠ WHY THIS KEYS ON THE CACHE ENTRY AND NOT ON THE OWNER. There is already a
# server-side release for hook locks — releaseOwnerHookFileLocks
# (operator-core/lib/agent-tools/locks/release-hook-locks.ts, EI-21878494442396728)
# — but it runs ONLY at the carry-respawn point, and its own header explains why
# it must not be lifted anywhere else: a lock row carries no session id, only an
# owner, so an owner-keyed release cannot tell a DEAD session's locks from a live
# successor's and would delete the lock protecting an in-flight edit. This sweep
# is safe in a LIVE session — the case that surface deliberately cannot cover,
# because no respawn happens; the agent just keeps working — precisely because it
# does not key on the owner. It releases one specific tool_use_id whose
# PostToolUse provably never ran, by that claim's own lock_id; the `.owner`
# sidecar is only a can-I-release-this filter, never the selector.
ORPHAN_GRACE_SEC = float(os.environ.get('PAPERCUSP_LOCKS_ORPHAN_GRACE_SEC') or 180)
# Past the lock's own TTL the row is gone server-side; only the cache litter is
# left, so those are pruned from disk WITHOUT an API call.
ORPHAN_EXPIRED_SEC = float(os.environ.get('PAPERCUSP_LOCKS_ORPHAN_EXPIRED_SEC') or 1500)
ORPHAN_RELEASE_MAX = int(os.environ.get('PAPERCUSP_LOCKS_ORPHAN_RELEASE_MAX') or 25)
ORPHAN_PRUNE_MAX = int(os.environ.get('PAPERCUSP_LOCKS_ORPHAN_PRUNE_MAX') or 200)
ORPHAN_SCAN_MAX = int(os.environ.get('PAPERCUSP_LOCKS_ORPHAN_SCAN_MAX') or 2000)
_ORPHAN_SUFFIXES = ('.lock', '.paths', '.domain', '.owner', '.batch',
                    '.edited', '.files', '.done', '.checked')


def _orphan_sidecar(base, suffix):
    try:
        with open(os.path.join(cache_dir, base + suffix)) as f:
            return f.read().strip()
    except Exception:
        return None


def _orphan_drop_files(base):
    for suffix in _ORPHAN_SUFFIXES:
        try:
            os.remove(os.path.join(cache_dir, base + suffix))
        except Exception:
            pass


def _sweep_orphaned_claims():
    """Release locks whose edit never happened, and prune dead cache entries.

    Bounded and best-effort in both directions: it never raises, never changes
    this call's decision, and issues at most ONE operator call, so an operator
    that is down costs one timeout rather than one per orphan.
    """
    attempted, released, pruned, scanned = [], [], 0, 0
    try:
        now = time.time()
        candidates = []
        with os.scandir(cache_dir) as entries:
            for entry in entries:
                if not entry.name.endswith('.lock'):
                    continue
                scanned += 1
                if scanned > ORPHAN_SCAN_MAX:
                    break
                try:
                    age = now - entry.stat().st_mtime
                except Exception:
                    continue
                # Inside the grace window this may be the edit currently in
                # flight — its PostToolUse simply has not run YET.
                if age >= ORPHAN_GRACE_SEC:
                    candidates.append((age, entry.name[:-len('.lock')]))
        candidates.sort(reverse=True)  # oldest (longest-held) first
        for age, base in candidates:
            if age >= ORPHAN_EXPIRED_SEC:
                if pruned < ORPHAN_PRUNE_MAX:
                    _orphan_drop_files(base)
                    pruned += 1
                continue
            # A batch defers its release to the one PostToolBatch cleanup hook,
            # which owns that lifecycle — never race it.
            if os.path.exists(os.path.join(cache_dir, base + '.batch')):
                continue
            # Only the owning session can release its own lock, and this cache
            # is shared by every agent on the box. A peer's live orphan is
            # theirs to sweep on their next edit.
            if _orphan_sidecar(base, '.owner') != owner:
                continue
            if len(attempted) >= ORPHAN_RELEASE_MAX:
                break
            lock_id = _orphan_sidecar(base, '.lock')
            if lock_id:
                attempted.append((base, lock_id))
        if attempted:
            inner, rpc_error, _phase, exc = _best_effort_tool(
                'locks:release', {'lock_ids': [lid for _base, lid in attempted]})
            # Only drop the cache entry once the release actually landed —
            # otherwise keep it and retry on the next edit.
            if exc is None and rpc_error is None and isinstance(inner, dict) \
                    and inner.get('ok') is not False:
                for base, lock_id in attempted:
                    _orphan_drop_files(base)
                    released.append(lock_id)
        if attempted or pruned:
            # Never silent: a reconcile that runs invisibly cannot be audited,
            # and this one releases locks nobody asked it to touch.
            write_marker('last-orphan-sweep.json', {
                'ts': now_iso(), 'owner': owner,
                'attempted': len(attempted), 'released': released[:25],
                'released_count': len(released), 'pruned': pruned,
            })
    except Exception as exc:
        mark_error('orphan-sweep', exc)


def _locks_acquire_once(request):
    """One locks:acquire POST → the parsed inner tool result (a dict).
    Fail-open (allow → exit 0) on any transport or parse failure — identical
    posture to the previous inline flow; extracted so the EI-9478 transient
    retry below can re-attempt without duplicating the fail-open plumbing."""
    operation_started_at = time.time()
    raw_resp = None
    last_exc = None
    for _attempt in range(len(RETRY_BACKOFFS) + 1):
        try:
            resp = _opener.open(request, timeout=10)
            raw_resp = resp.read().decode('utf-8', errors='replace')
            break
        except Exception as e:
            last_exc = e
            if _is_conn_refused(e) and _attempt < len(RETRY_BACKOFFS):
                time.sleep(RETRY_BACKOFFS[_attempt])
                continue
            break
    if raw_resp is None:
        mark_error('connect', last_exc)
        print(f'[locks] operator unreachable ({last_exc}); allowing edit (fail-open)',
              file=sys.stderr)
        _recover_ambiguous_acquire(operation_started_at)
        if batch_info:
            return {
                '_hook_fail_open': True,
                '_detail': f'operator unreachable: {last_exc}',
            }
        allow()

    inner, rpc_error, phase = parse_mcp_response(raw_resp)
    if rpc_error is not None:
        compatibility_error = _coordination_domain_rejection(rpc_error)
        if compatibility_error:
            return {
                '_hook_compatibility_error': True,
                '_detail': compatibility_error,
            }
        detail = 'MCP tool returned isError:true' if phase == 'is-error' else 'JSON-RPC error in response'
        mark_error('parse', detail)
        _recover_ambiguous_acquire(operation_started_at)
        if batch_info:
            return {
                '_hook_fail_open': True,
                '_detail': detail,
            }
        allow()
    if phase != 'ok':
        detail = {
            'no-result': 'no JSON-RPC result in response',
            'no-text': 'no text content in tool result',
        }.get(phase, 'unparseable operator response')
        mark_error('parse', detail)
        _recover_ambiguous_acquire(operation_started_at)
        if batch_info:
            return {
                '_hook_fail_open': True,
                '_detail': detail,
            }
        allow()
    compatibility_error = _coordination_domain_rejection(inner)
    if compatibility_error:
        return {
            '_hook_compatibility_error': True,
            '_detail': compatibility_error,
        }
    return inner


def _timestamp_epoch(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        normalized = value.replace('Z', '+00:00')
        return datetime.fromisoformat(normalized).timestamp()
    except Exception:
        return None


def _recover_ambiguous_acquire(started_at):
    """Release only a just-created automatic lock after a lost acquire reply.

    The acquire is a write: the operator can commit the lock and lose the MCP
    result before this hook caches the lock_id. A targeted queue read followed
    by an owner/domain/intent/timestamp match closes that gap without using
    ``all_mine`` (which could destroy a deliberate multi-file hold).
    """
    # Recovery is only unambiguous for one physical coordination domain. The
    # normal Papercusp edit path has one; mixed external/repository edits are
    # deliberately left fail-open rather than risking a cross-domain release.
    if len(repo_domains) != 1:
        return
    expected_domain = next(iter(repo_domains))
    queue_arguments = {
        'paths': repo_relative[:50],
        'owner': owner,
    }
    queued, rpc_error, phase, exc = _best_effort_tool('locks:queue', queue_arguments)
    if exc is not None:
        mark_error('recovery-queue', exc)
        return
    if rpc_error is not None or phase != 'ok' or not isinstance(queued, dict):
        if rpc_error is not None:
            mark_error('recovery-queue', rpc_error)
        return

    rows = queued.get('active_locks')
    if not isinstance(rows, list):
        rows = queued.get('activeLocks')
    if not isinstance(rows, list):
        rows = queued.get('locks')
    if not isinstance(rows, list):
        return

    expected_intent = lock_arguments['intent']
    newest_allowed = time.time() + 2
    matched = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_owner = row.get('owner') or row.get('owner_id') or row.get('ownerId')
        row_intent = row.get('intent')
        row_domain = (row.get('coordination_domain') or
                      row.get('coordinationDomain'))
        lock_id = row.get('lock_id') or row.get('lockId')
        acquired_at = (row.get('acquired_ts') or row.get('acquiredAt') or
                       row.get('acquired_at'))
        acquired_epoch = _timestamp_epoch(acquired_at)
        if row_owner != owner or row_intent != expected_intent:
            continue
        if row_domain != expected_domain or not lock_id:
            continue
        if acquired_epoch is None or acquired_epoch < started_at - 2:
            continue
        if acquired_epoch > newest_allowed:
            continue
        row_paths = row.get('paths')
        if not isinstance(row_paths, list):
            row_paths = [row.get('path')]
        for path in row_paths:
            if not isinstance(path, str) or path not in repo_relative:
                continue
            key = (lock_id, row_domain)
            matched.setdefault(key, []).append(path)

    for (lock_id, row_domain), paths in matched.items():
        release_arguments = {
            'lock_id': lock_id,
            'paths': sorted(set(paths)),
            'coordination_domain': row_domain,
        }
        released, release_error, release_phase, release_exc = _best_effort_tool(
            'locks:release', release_arguments,
        )
        if release_error is not None and _coordination_domain_rejection(release_error):
            del release_arguments['coordination_domain']
            released, release_error, release_phase, release_exc = _best_effort_tool(
                'locks:release', release_arguments,
            )
        if release_exc is not None:
            mark_error('recovery-release', release_exc)
        elif release_error is not None or release_phase != 'ok' or not isinstance(released, dict):
            mark_error('recovery-release', release_error or release_phase)
        elif released.get('ok') is False:
            mark_error('recovery-release', released)


def _grant(granted):
    """Cache the lock_id (+ only newly acquired paths) for the matching
    PostToolUse release, then allow.

    EI-63: when the calling owner already holds one of these paths under a
    distinct EXPLICIT lock_id (a deliberate multi-file locks:acquire held
    across several edits), the server's tryAcquire REUSES that existing
    lock_id for this grant (su-lock-store.ts: "reuse that lock_id ... so the
    entire returned set shares ONE lock_id"). If PostToolUse then releases by
    lock_id ALONE, it deletes every path under that lock_id — silently
    dissolving the rest of the explicit hold, not just the one path this edit
    touched. Caching the paths here lets PostToolUse scope its release to
    exactly this edit's path(s), which is a no-op regression for the common
    case (a fresh, non-shared lock_id covers exactly these paths anyway) and
    the actual fix for the shared-lock_id case. The server now returns
    ``newly_held``; an empty list means this automatic edit was covered by an
    existing deliberate hold, so it must not create a release token at all."""
    lock_id = granted.get('lock_id')
    newly_held = granted.get('newly_held')
    if isinstance(newly_held, list):
        release_paths = [p for p in newly_held if isinstance(p, str) and p]
    else:
        # Older operators do not send the additive field. Preserve their
        # existing behavior rather than silently allowing an untracked edit.
        release_paths = repo_relative[:50]
    if batch_info:
        _batch_terminal_state(
            'granted',
            lock_id=lock_id,
            release_paths=release_paths,
            coordination_domain=(next(iter(repo_domains)) if len(repo_domains) == 1 else None),
        )
        _batch_mark_tool('granted')
        write_marker('last-decision.json', {
            'ts': now_iso(),
            'decision': 'batch-leader-granted',
            'owner': owner,
            'tool': tool_name,
            'paths': repo_relative[:50],
            'release_paths': release_paths,
            'lock_id': lock_id,
            'batch_id': batch_info['batch_id'],
        })
        _clear_transient_streak()
        allow()
    decision = {
        'ts': now_iso(),
        'decision': 'already-held' if isinstance(newly_held, list) and not release_paths else 'granted',
        'owner': owner,
        'tool': tool_name,
        'paths': repo_relative[:50],
        'release_paths': release_paths,
        'lock_id': lock_id,
        **({'coordination_domain': next(iter(repo_domains))} if len(repo_domains) == 1 else {}),
    }
    write_marker('last-decision.json', decision)
    write_marker(owner_marker_name('decision'), decision)
    if lock_id and tool_use_id and release_paths:
        try:
            with open(os.path.join(cache_dir, tool_use_id + '.lock'), 'w') as f:
                f.write(lock_id)
            with open(os.path.join(cache_dir, tool_use_id + '.paths'), 'w') as f:
                json.dump(release_paths, f)
            # Stamp the claiming session so the orphan reconcile can tell OUR
            # abandoned claim from a peer's — only the owner can release it.
            with open(os.path.join(cache_dir, tool_use_id + '.owner'), 'w') as f:
                f.write(owner)
            if len(repo_domains) == 1:
                with open(os.path.join(cache_dir, tool_use_id + '.domain'), 'w') as f:
                    f.write(next(iter(repo_domains)))
        except Exception:
            pass
    _clear_transient_streak()
    allow()


def _batch_deny(reason):
    if batch_info:
        _batch_terminal_state('denied', reason=reason)
        _batch_mark_tool('denied')
    deny(reason)


def _is_transient(res):
    """EI-9478: `workspace_contended` = an advisory-lock serialization
    timeout whose holder identity is UNKNOWN. It does not prove that no
    agent holds the requested paths. Older servers surfaced the same
    condition as ok:false with NO reason and an EMPTY busy list — treat that
    shape as transient too, never as a foreign hold."""
    return res.get('reason') == 'workspace_contended' or (
        not res.get('reason') and not (res.get('busy') or []))


# EI-19324697909459657: "transient" and "one-off" are NOT the same claim, and
# the pre-fix message conflated them — it told the agent to "Simply RETRY"
# even after the SAME owner had already retried (both in-hook backoffs above
# AND the server's own acquireWithContentionRetry) and failed repeatedly. A
# genuine parallel-edit race self-heals in 1-2 attempts (see the 'heals on
# retry' test below); a run of consecutive failures for one owner instead
# points at a condition that has not self-healed. Track a per-owner streak
# across separate hook invocations (each Edit call is a fresh subprocess, so
# in-process state can't see across attempts) and, once it crosses a threshold,
# stop suggesting blind retry while preserving the only truthful fact: the
# advisory timeout did not identify its holder.
TRANSIENT_STREAK_ESCALATE_AT = 3


def _transient_streak_file():
    return os.path.join(cache_dir, owner_marker_name('transient-streak'))


def _read_transient_streak():
    try:
        with open(_transient_streak_file()) as f:
            v = json.load(f)
        c = v.get('count') if isinstance(v, dict) else None
        if isinstance(c, int) and c >= 0:
            return c
    except Exception:
        pass
    return 0


def _bump_transient_streak():
    count = _read_transient_streak() + 1
    write_marker(owner_marker_name('transient-streak'), {'count': count, 'ts': now_iso()})
    return count


def _clear_transient_streak():
    try:
        os.remove(_transient_streak_file())
    except Exception:
        pass


def _batch_allow_fail_open(result):
    if not batch_info or not isinstance(result, dict) or not result.get('_hook_fail_open'):
        return False
    reason = result.get('_detail') or 'operator response unavailable'
    _batch_terminal_state('allowed', reason=reason)
    _batch_mark_tool('allowed')
    allow()
    return True


# Reconcile BEFORE acquiring, not after: the reported failure is an agent whose
# retry of the very edit that was blocked is then refused by the orphan its own
# blocked attempt left behind. Sweeping first is what makes that self-heal.
_sweep_orphaned_claims()

request = req
inner = _locks_acquire_once(request)
_batch_allow_fail_open(inner)
if inner.get('_hook_compatibility_error'):
    if req_without_coordination_domain is None:
        mark_error('compatibility', inner.get('_detail', 'coordination_domain rejected'))
        if batch_info:
            _batch_terminal_state('allowed', reason=inner.get('_detail'))
            _batch_mark_tool('allowed')
        allow()
    # The tree hook can update before the operator process reaches main. Keep
    # the edit protected by retrying the same acquire against the older
    # argument contract, and surface the skew as a non-blocking advisory.
    compatibility_advisory = (
        'locks:acquire compatibility fallback: the running operator rejected '
        'the coordination_domain argument (likely hook/operator version skew). '
        'Retried without that field and retained file-lock enforcement; '
        'domain isolation is unavailable until the operator deploy catches up.'
    )
    mark_error('compatibility', inner.get('_detail', 'coordination_domain rejected'))
    request = req_without_coordination_domain
    inner = _locks_acquire_once(request)
    _batch_allow_fail_open(inner)
# We reached the operator and got a usable answer → enforcement healthy.
mark_success()

if inner.get('ok') is True:
    _grant(inner)

# EI-9478: transient serialization timeout — RETRY briefly before any deny, so
# a batch of parallel edits from one session self-heals instead of one arm
# being denied with a fabricated "held by another agent" (which could strand a
# half-applied multi-edit batch for git-sync to auto-commit broken).
if _is_transient(inner):
    for _backoff in (0.6, 1.2):
        time.sleep(_backoff)
        inner = _locks_acquire_once(request)
        if inner.get('ok') is True:
            _grant(inner)
        if not _is_transient(inner):
            break

if _is_transient(inner):
    _streak = _bump_transient_streak()
    if _streak >= TRANSIENT_STREAK_ESCALATE_AT:
        _batch_deny(
            f'locks: PERSISTENT transient contention — attempt #{_streak} in a row for '
            'this session. The advisory-lock timeout did not identify a holder; '
            'that is unknown, not evidence that the requested files are unheld. '
            'Stop immediately repeating this same acquire and inspect the lock '
            'service state or pivot to another task. Do NOT queue wake_on_grant '
            'for a timeout that produced no holder or waiter ticket.'
        )
    _batch_deny(
        'locks: transient contention — the lock service could not serialize this '
        'acquire in time (advisory-lock timeout; holder identity is unknown). '
        'This does not prove the requested files are unheld. Simply RETRY this '
        'same edit — do NOT queue wake_on_grant for this timeout because no '
        'holder or waiter ticket was returned.'
    )

# Busy (or another refusal) → deny with a reason the agent can act on.
busy = inner.get('busy') or []
lines = []
if inner.get('reason'):
    lines.append(f"locks: refused — {inner['reason']}")
else:
    lines.append('locks: file(s) held by another agent:')
for b in busy[:5]:
    label = b.get('owner_label') or b.get('owner')
    # Prefer the holder's DECLARED coord intent (what they're actually
    # changing) over the lock's own `intent`, which is a generic
    # 'PreToolUse:Edit' for hook-acquired edit locks. The server fills
    # holder_intent from coord:presence (declare-intent) when set.
    intent = b.get('holder_intent') or b.get('intent')
    focus = ' [focused on this file]' if b.get('holder_focused') else ''
    lines.append(
        f"  - {b.get('path')}: {label} — {intent!r}{focus} "
        f"(until {b.get('expires_ts')})"
    )
if len(busy) > 5:
    lines.append(f"  …and {len(busy) - 5} more")
lines.append('Options: locks:acquire {paths, intent, wake_on_grant:true} to queue '
             'and SLEEP — end your turn and you are re-invoked when the lock is '
             'granted (no polling). Or pivot to other work meanwhile; the wake '
             'arrives either way.')
paths = [b.get('path') for b in busy[:5] if b.get('path')]
lines.append('If locks:acquire is not on this client surface, use '
             'tools:invoke {name:"locks:acquire", args:{paths:' + json.dumps(paths) +
             ', intent:"<your intent>", wake_on_grant:true}} and end this turn.')
_batch_deny('\n'.join(lines))
PYEOF
