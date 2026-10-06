#!/usr/bin/env bash
# Claude Code statusline — render a compact CROSS-CLI FLEET glance from
# `coord:glance` (papercusp-worker-integration-2026-06-04 D-005 + the
# coord-glance combined read, 2026-06-12).
#
# SINGLE-SOURCE (tui-status-parity-single-source-2026-07-05): when the operator
# ships a server-rendered `display` block on the glance (status-display.ts),
# this hook prints display.statusline / display.title VERBATIM (width-fitting
# only). New chips belong in status-display.ts — NOT here; the local assembly
# below is only the fallback for a pre-display operator. Two lines:
#
#   🔭 wire objective display · ◇ su-9859e · ⏸ manual ✉2 · ☕1 · 5 peers · ◆ su-074be ✎ catalog.ts
#   💡 Wake mode is manual — 2 staged wakes waiting; … /mcp__papercusp-su__tool:coord:wake-mode mode=auto
#   ⋯ run /mcp__papercusp-su__tool:coord:glance for detail
#
# Line 1 LEADS with this session's CURRENT objective (🔭 <objective> — its
# in-execution work-item title ?? declared coord intent, from the glance
# payload's `self.objective`; session-objective-display-2026-06-22) so the human
# sees WHAT this terminal is doing before the fleet shorthand. Then THIS agent's
# own papercusp shorthand id (◇ <id> — the coord ownerLabel
# form, e.g. ◇ su-9859e, so a human can correlate the terminal with coord/fleet
# tools; paired with the ◆ filled-diamond that marks the most-recent PEER),
# wake-gate state (▶ auto / ⏸ manual, ✉ staged wakes), bees in flight,
# governor pauses, peer count + most-recent peer action. Line 2 (only when the
# server has a tip for this state): the top contextual tip from the glance tips
# engine, usually with the slash command that resolves it. Line 3 (only when a
# tip is shown): a ⋯ affordance pointing at the full `coord:glance` dump — the
# statusline itself has no expand affordance and clips line 1 to fit, so this is
# how a human reaches the unabridged state.
#
# Claude invokes a statusline command frequently, so this is CHEAP + FAIL-OPEN:
# ONE `coord:glance` call with a short timeout; if the operator predates the
# tool (pre-deploy window) it falls back to the legacy `activity:recent`
# single-line render; on any other trouble it prints nothing and exits 0.
# NEVER blocks, never errors. Registered NON-destructively by
# install-standalone-mcp.sh (only when the user has no existing statusLine).
#
# Claude passes a session JSON object on stdin (model / cwd / session_id / …); we
# read PAPERCUSP_SID from the env (the psu launch exports it, same as the hooks)
# and don't depend on the stdin shape. COLUMNS is set by Claude Code (≥2.1.153)
# and bounds the render width.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

# Drain stdin (Claude pipes session JSON) so the pipe closes cleanly; we don't need it.
INPUT="$(cat 2>/dev/null || true)"

# In SYNC/test mode read a glance-shaped JSON payload from
# $PAPERCUSP_STATUSLINE_FIXTURE instead of the operator, so the render logic is
# testable without a live operator (or a token).
if [ -z "${PAPERCUSP_STATUSLINE_FIXTURE:-}" ]; then
  # Not a psu session / not installed → print nothing (Claude falls back to its default).
  if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
    exit 0
  fi
fi

# WI-10004953: a claude NESTED inside another agent inherited that su's PAPERCUSP_SID and
# PAPERCUSP_TTY. Its statusline would call coord:glance AS the su and write the su's title
# to the su's own terminal with the nested CLI's model. Print nothing (Claude falls back to
# its default). Cached per CLI process (pc_nested_cli.sh); any failure runs the render.
if [ -n "${PAPERCUSP_SID:-}" ] && . "$(dirname "$0")/pc_nested_cli.sh" 2>/dev/null && pc_nested_cli_cached; then
  exit 0
fi

python3 - "$OPERATOR_URL" "$TOKEN_PATH" "${PAPERCUSP_SID:-fixture}" "${PAPERCUSP_STATUSLINE_FIXTURE:-}" "$(dirname "$0")" 3<<<"$INPUT" <<'PYEOF' 2>/dev/null || exit 0
import datetime, hashlib, json, os, re, sys, tempfile, textwrap, time, urllib.request, urllib.parse
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy (502s the local call -> false fail-open)

operator_url, token_path, me, fixture = sys.argv[1:5]
# pc_tty lives beside this script in BOTH locations it runs from: the repo
# (apps/operator/scripts/hooks/cc, used by the parity tests) and the installed
# runtime dir (~/.papercusp/hooks/cc, copied together by install-standalone-mcp.sh).
# Resolving it off $0's dirname is what makes one copy serve both.
sys.path.insert(0, sys.argv[5] if len(sys.argv) > 5 else os.path.dirname(os.path.abspath(__file__)))
from mcp_response import read_hook_payload, read_token_file  # noqa: E402
from pc_tty import coordination_owner_id, write_osc_title  # noqa: E402  (path must be primed first)
stdin_raw = read_hook_payload()  # Claude's piped session JSON; '' in fixture/test mode
token = read_token_file(token_path)
HTTP_TIMEOUT = 1.5
ACTIVITY_WINDOW = 12  # rows for the peer-glance scan
GATEWAY_URL = os.environ.get('PAPERCUSP_GATEWAY_URL', 'http://127.0.0.1:8788')
OBJECTIVE_MAX = 48  # clip a long objective so the 🔭 segment can't swallow line 1
# Own-cache TTL. It was 5s, which is SHORTER than a coord:glance round-trip under fleet load
# (measured 2026-09-23: p50 4.9s, avg 8.1s), so Claude's statusline bursts missed the cache
# and the statusline alone issued ~3.5k glance RPCs/hour (P-012, review-system-rework-reduction).
GLANCE_CACHE_TTL_SEC = float(os.environ.get('PAPERCUSP_STATUSLINE_GLANCE_TTL_SEC') or '30')
# The PostToolUse activity hook already hydrates a glance into its per-owner bundle cursor, and
# refreshes it ONLY when coordination state changes (generation) or it is older than 60s
# (posttooluse-activity-report.sh GLANCE_MAX_AGE_SEC). Reading that snapshot first is what
# gates the statusline's glance on change: while the agent is working, the statusline makes no
# RPC of its own.
BUNDLE_GLANCE_MAX_AGE_SEC = float(os.environ.get('PAPERCUSP_STATUSLINE_BUNDLE_MAX_AGE_SEC') or '60')
BUNDLE_CACHE_DIR = os.environ.get('PAPERCUSP_LOCKS_CACHE_DIR') or os.path.join(
    os.path.expanduser('~'), '.papercusp', 'locks-cache')
# Single-flight: while one render's glance RPC is in flight, concurrent renders reuse the last
# snapshot instead of each firing their own (a burst used to stack N identical slow calls).
INFLIGHT_MAX_SEC = float(os.environ.get('PAPERCUSP_STATUSLINE_INFLIGHT_MAX_SEC') or '20')
STALE_FALLBACK_MAX_SEC = 600  # never show a snapshot older than this while a refresh runs
GLANCE_CACHE_DIR = os.environ.get(
    'PAPERCUSP_STATUSLINE_CACHE_DIR',
    os.path.join(os.environ.get('XDG_RUNTIME_DIR') or tempfile.gettempdir(), 'papercusp-statusline-glance'),
)

# Claude's internal re-exec can leave PAPERCUSP_SID spelling a fresh/unregistered
# id while the native session's coordination owner remains stable. Resolve the
# title/glance caller through psu-session-owners when the hook payload names the
# native session, with the ambient SID as the fail-open fallback.
me = coordination_owner_id(stdin_raw, os.environ)


def call_tool(name, args):
    """One MCP JSON-RPC tools/call → the inner tool payload (or None).

    `format=json` is REQUIRED on the URL (result-format negotiation, P-009): the
    fleet-wide tool-result default is TOON text, which json.loads() below cannot
    parse — without the pin every glance came back unparseable, this returned
    None, and the caller took the legacy double-call fallback on EVERY render
    (~4k wasted activity:recent calls/hour fleet-wide, EI-7029)."""
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': name, 'arguments': args}}).encode()
    req = urllib.request.Request(
        operator_url.rstrip('/') + '/api/mcp?superuser=1&origin=hook&format=json&client=' + urllib.parse.quote(me, safe=''),
        data=body,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                 'Accept': 'application/json, text/event-stream'},
        method='POST')
    raw = urllib.request.urlopen(req, timeout=HTTP_TIMEOUT).read().decode('utf-8', 'replace')
    # Parse a JSON or SSE-framed JSON-RPC result → the inner tool payload.
    result = None
    for line in raw.splitlines():
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


def _cache_path():
    """Session+operator scoped statusline cache path. Fixture mode bypasses this entirely."""
    key = hashlib.sha256(f'{operator_url.rstrip()}|{me}'.encode()).hexdigest()[:24]
    return os.path.join(GLANCE_CACHE_DIR, f'{key}.json')


def _own_cached_glance():
    """(payload, epoch) of this statusline's own last coord:glance snapshot, or (None, None).

    Age is NOT checked here — get_glance() decides whether the snapshot is fresh enough or
    only usable as a stale fallback. Corrupt/missing files read as absent (best-effort cache).
    """
    if GLANCE_CACHE_TTL_SEC <= 0:
        return None, None
    try:
        path = _cache_path()
        mtime = os.path.getmtime(path)
        with open(path) as f:
            data = json.load(f)
        return (data, mtime) if isinstance(data, dict) else (None, None)
    except Exception:
        return None, None


def _bundle_glance():
    """(glance, epoch) from the PostToolUse activity hook's bundle cursor, or (None, None).

    Same file + owner-key normalisation as posttooluse-activity-report.sh's cursor_path() and
    posttooluse-objective-title.sh's read_cached_glance(). The epoch is the SERVER observation
    time (glanceObservedAt), not the file mtime — the hook rewrites the file on every call,
    including calls that carried no fresh glance.
    """
    try:
        safe = re.sub(r'[^A-Za-z0-9._-]', '_', me)[:120]
        with open(os.path.join(BUNDLE_CACHE_DIR, f'activity-hook-bundle-{safe}.json')) as f:
            state = json.load(f)
        glance = state.get('glance') if isinstance(state, dict) else None
        observed = state.get('glanceObservedAt') if isinstance(state, dict) else None
        if not isinstance(glance, dict) or not isinstance(observed, str) or not observed:
            return None, None
        parsed = datetime.datetime.fromisoformat(observed.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return glance, parsed.timestamp()
    except Exception:
        return None, None


def _inflight_path():
    return _cache_path() + '.inflight'


def _claim_refresh():
    """True when THIS render should issue the glance RPC; False when a peer render already is.

    O_EXCL create of a marker file. A marker older than INFLIGHT_MAX_SEC belongs to a render
    that died mid-call, so it is replaced rather than honoured forever.
    """
    try:
        os.makedirs(GLANCE_CACHE_DIR, mode=0o700, exist_ok=True)
        path = _inflight_path()
        try:
            if time.time() - os.path.getmtime(path) <= INFLIGHT_MAX_SEC:
                return False
            os.unlink(path)
        except FileNotFoundError:
            pass
        os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        return True
    except FileExistsError:
        return False
    except Exception:
        return True  # cache dir unusable → behave as before (one live read)


def _release_refresh():
    try:
        os.unlink(_inflight_path())
    except Exception:
        pass


def _write_cached_glance(data):
    if GLANCE_CACHE_TTL_SEC <= 0 or not isinstance(data, dict):
        return
    try:
        os.makedirs(GLANCE_CACHE_DIR, mode=0o700, exist_ok=True)
        path = _cache_path()
        tmp = f'{path}.{os.getpid()}.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f, separators=(',', ':'))
        os.replace(tmp, path)
    except Exception:
        pass


def get_glance():
    """The newest usable glance, issuing a coord:glance RPC only when nothing fresh exists.

    Order: the newer of (own snapshot within GLANCE_CACHE_TTL_SEC, bundle snapshot within
    BUNDLE_GLANCE_MAX_AGE_SEC) → otherwise ONE render refreshes while concurrent renders show
    the newest snapshot up to STALE_FALLBACK_MAX_SEC old → otherwise a live read.
    """
    now = time.time()
    own, own_at = _own_cached_glance()
    bundle, bundle_at = _bundle_glance()
    candidates = []
    if own is not None and 0 <= now - own_at <= GLANCE_CACHE_TTL_SEC:
        candidates.append((own_at, own))
    if bundle is not None and 0 <= now - bundle_at <= BUNDLE_GLANCE_MAX_AGE_SEC:
        candidates.append((bundle_at, bundle))
    if candidates:
        return max(candidates, key=lambda c: c[0])[1]
    if not _claim_refresh():
        stale = [(at, g) for at, g in ((own_at, own), (bundle_at, bundle))
                 if g is not None and 0 <= now - at <= STALE_FALLBACK_MAX_SEC]
        if stale:
            return max(stale, key=lambda c: c[0])[1]
        return None
    try:
        fresh = call_tool('coord:glance', {
            'audience': 'user',
            'activity_limit': ACTIVITY_WINDOW,
            'display_only': True,
        })
        _write_cached_glance(fresh)
        return fresh
    finally:
        _release_refresh()


def peer_glance(rows):
    """(peer_count, latest_peer_row) from newest-first activity rows."""
    others, peer = [], None
    for r in rows or []:
        owner = r.get('owner_id')
        if not owner or owner == me:
            continue
        if owner not in others:
            others.append(owner)
        if peer is None:
            peer = r
    return len(others), peer


def peer_part(peer):
    owner = str(peer.get('owner_id') or '?')
    short = owner[-6:] if len(owner) > 6 else owner
    summ = (peer.get('summary') or '').strip()
    return f'◆ {short} {summ}'[:60] if summ else None


def self_short(owner):
    """THIS agent's papercusp shorthand id, matching the coord ownerLabel form
    (role prefix + first 5 chars of the uuid body, e.g.
    su-9859ea5e-…→su-9859e) — the id a human sees in coord/fleet tools, so it
    correlates the terminal with the rest of the fleet. '' when there's no real
    session id (e.g. the 'fixture'/unset sentinel)."""
    owner = str(owner or '').strip()
    if not owner or owner == 'fixture':
        return ''
    bits = owner.split('-')
    if len(bits) >= 2 and bits[1]:
        return f'{bits[0]}-{bits[1][:5]}'
    return owner[:8]


def routed_account(owner):
    """The pool account that served THIS session's most-recent turn, from the inference gateway's
    GET /admin/route?owner=<id> (routed-account visibility, 2026-06-22). The gateway strips its routing
    headers before the caller sees them, so this read-back is how a session learns where its turn went.
    Cheap + fail-open: a short timeout, None on any trouble (gateway down / owner unseen / not a psu session)."""
    if not owner or owner == 'fixture':
        return None
    try:
        u = GATEWAY_URL.rstrip('/') + '/admin/route?owner=' + urllib.parse.quote(owner, safe='')
        raw = urllib.request.urlopen(u, timeout=0.6).read().decode('utf-8', 'replace')
        return (json.loads(raw) or {}).get('account')
    except Exception:
        return None


def objective_part(g):
    """The leading 🔭 <objective> segment from the glance payload's `self.objective`
    (session-objective-display-2026-06-22) — this session's CURRENT work-item title ??
    declared coord intent, the single client-agnostic source every CLI status display reads.
    ADDITIVE + FAIL-OPEN: None when the operator predates the field or the objective is
    blank/absent, so the existing render is untouched. Clipped so a verbose objective can't
    crowd out the fleet shorthand on line 1."""
    if not isinstance(g, dict):
        return None
    obj = (g.get('self') or {}).get('objective')
    if not isinstance(obj, str):
        return None
    obj = obj.strip()
    if not obj:
        return None
    if len(obj) > OBJECTIVE_MAX:
        obj = obj[:OBJECTIVE_MAX - 1].rstrip() + '…'
    return f'🔭 {obj}'


def fmt_interval(sec):
    """Compact interval label for the loop chip: 120→'2m', 30→'30s', 3600→'1h', 5400→'1h30m'."""
    try:
        s = int(sec)
    except Exception:
        return '?'
    if s < 60:
        return f'{s}s'
    m = s // 60
    if m < 60:
        return f'{m}m'
    h, rm = m // 60, m % 60
    return f'{h}h' if rm == 0 else f'{h}h{rm}m'


def loop_part(g):
    """The ⟳ loop chip from the glance payload's `self.loop` (loop-status-display-2026-06-23).
    ALWAYS shows loop-armed state when the operator supports the field, so a human can tell at a
    glance whether THIS session is looping (owner ask 2026-07-05): `⟳ <interval>` when on an engine
    loop (loop:arm), `⟳ off` when not. FAIL-OPEN: None only when `self.loop` is absent entirely
    (operator predates the field ⇒ unknown, stay quiet), so the existing render is untouched there."""
    if not isinstance(g, dict):
        return None
    self_obj = g.get('self')
    if not isinstance(self_obj, dict) or 'loop' not in self_obj:
        return None  # old operator / field absent ⇒ unknown, not "off"
    lp = self_obj.get('loop')
    if not isinstance(lp, dict) or not lp.get('active'):
        return '⟳ off'  # field present but no loop armed ⇒ show it EXPLICITLY
    # WI-655: a loop that fired but reached nobody (no-session-now) / whose wake turn died
    # reads `reachable: False` — surface it LOUDLY so a black-holed loop isn't invisible in
    # the bottom display. `reachable` absent (older operator) ⇒ unknown ⇒ no scary text (fail-open).
    if lp.get('reachable') is False:
        return f'⟳ {fmt_interval(lp.get("intervalSec"))} ⚠unreachable'
    return f'⟳ {fmt_interval(lp.get("intervalSec"))}'


def modes_part(g):
    """The standing-modes chip from the glance payload's `self.modes` (EI-7626 /
    modes-and-intake-ux P-007): the session's OFFICIAL agent_modes set rendered as
    `▣ auto+ideate`, so the human sees the standing grants (autonomy dial + overlays)
    every tick without opening a tool. Distinct glyph from the ▶/⏸ WAKE-GATE chip —
    'auto' appears in both but means different things (mode grant vs wake delivery).
    ADDITIVE + FAIL-OPEN: None when absent / empty / old operator."""
    if not isinstance(g, dict):
        return None
    m = (g.get('self') or {}).get('modes')
    if not isinstance(m, list):
        return None
    m = [str(x) for x in m if isinstance(x, str) and x]
    if not m:
        return None
    return '▣ ' + '+'.join(m[:4])


def context_part(g):
    """The `ctx N%` context-usage gauge chip from the glance payload's `self.context`
    (agent-managed-compaction P-015): an ambient readout of how full THIS session's context
    is, every statusline tick. ⚠-prefixed at/above the LOUD band (80%, mirrors
    CONTEXT_GAUGE_LOUD_PCT) so an approaching compaction is visible without opening a tool.
    ADDITIVE + FAIL-OPEN: None when absent / uncomputable / old operator, so the existing
    render is untouched."""
    if not isinstance(g, dict):
        return None
    c = (g.get('self') or {}).get('context')
    if not isinstance(c, dict):
        return None
    pct = c.get('pct')
    if not isinstance(pct, (int, float)) or isinstance(pct, bool):
        return None
    pct = int(pct)
    return f'⚠ ctx {pct}%' if pct >= 80 else f'ctx {pct}%'


def _session_json(raw):
    """Parse Claude Code's piped session JSON (model / cwd / session_id / …). {} on any trouble — fail-open."""
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _user_settings():
    """~/.claude/settings.json — the persisted `model` + `effortLevel` (what /effort writes). {} fail-open.
    Read ONLY in a real session (the caller gates it off in fixture/test mode) so a dev's settings never
    leak into the deterministic render tests."""
    try:
        with open(os.path.join(os.path.expanduser('~'), '.claude', 'settings.json')) as f:
            v = json.load(f)
            return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _compact_model(*names):
    """A short model label from any candidate string (live model.display_name/id, settings `model`):
    the family word (opus/sonnet/haiku) + a `[1m]` marker for a 1M-context variant (e.g.
    'Opus 4.8 (1M context)' / 'opus[1m]' → 'opus[1m]'). '' when nothing usable."""
    onem = False
    fam = ''
    for n in names:
        s = str(n or '').lower()
        if not s:
            continue
        if '1m' in s:
            onem = True
        if not fam:
            for f in ('opus', 'sonnet', 'haiku', 'fable'):
                if f in s:
                    fam = f
                    break
    if not fam:
        for n in names:
            s = str(n or '').strip()
            if s:
                fam = s.split()[0].split('-')[0].lower()
                break
    return (fam + ('[1m]' if onem else '')) if fam else ''


def _same_family(spec, label):
    """True when `spec` (a launch model spec) names the SAME family word as `label` (a compact
    'opus' / 'opus[1m]' render). Gates the settings→live [1m] reinforcement so a stale spec can
    never mark a DIFFERENT live family."""
    fam = str(label or '').replace('[1m]', '').strip().lower()
    return bool(fam) and fam in str(spec or '').lower()


def model_bits(sj, settings):
    """(label, effort): the compact model label + reasoning-effort the human asked to see.

    The LIVE session model (Claude's piped model.display_name/id) is AUTHORITATIVE — it changes
    the instant you /model-switch — so family + the [1m] marker are derived from it ALONE. The
    persisted launch spec (settings `model`) must NOT contaminate the live label: THAT was the
    'often incorrect' bug (owner, 2026-07-03) — after switching e.g. opus→sonnet, the stale
    launch `opus[1m]` both marked the live sonnet as [1m] and could override the family, so the
    statusline showed a model you were no longer on. settings `model` is now consulted only to
    (a) supply the WHOLE label when CC piped no model at all, or (b) REINFORCE [1m] when it names
    the SAME family as the live model (a CLI whose display_name omits the 1M marker but was
    launched --model <fam>[1m]). Effort: settings `effortLevel` (the /effort default) ?? a
    session-JSON `effort`. Either bit may be '' (unknown) — fail-open."""
    m = sj.get('model') if isinstance(sj.get('model'), dict) else {}
    live = [x for x in (m.get('display_name'), m.get('id')) if str(x or '').strip()]
    if live:
        label = _compact_model(*live)  # live model wins ALONE — no stale-settings contamination
        sm = str(settings.get('model') or '')
        if label and '[1m]' not in label and _same_family(sm, label) and '1m' in sm.lower():
            label += '[1m]'
    else:
        label = _compact_model(settings.get('model'))  # CC piped no model → fall back to the launch spec
    effort = str(settings.get('effortLevel') or sj.get('effort') or '').strip()
    return label, effort


def model_chip(label, effort):
    """Statusline-body chip — '🧠 opus[1m]·xhigh'. None when neither bit is known (fixture/test with no
    stdin), so the existing render + tests stay untouched (additive + fail-open)."""
    body = '·'.join(x for x in (label, effort) if x)
    return ('🧠 ' + body) if body else None


def model_title(label, effort):
    """Plain (emoji-free) OS-title segment — 'opus[1m]/xhigh'. '' when neither is known."""
    return '/'.join(x for x in (label, effort) if x)


def fleets_part(g):
    """The fleet-identity segment for the OS title (multi-fleet-terminal-identity, WI-1963): one chip per
    named fleet this agent is in — 👑 (leader) / 👤 (member) + the fleet name + its bound color SQUARE —
    from the glance payload's `self.fleets`. A window has only ONE background colour (OSC 11), so an agent
    in N fleets shows the other fleets as N colour squares HERE instead. ADDITIVE + FAIL-OPEN: '' when the
    agent is in no fleet, or the field is absent (older operator), so the existing title is untouched.
    Caps at 4 chips (+N overflow) and clips each name so a many-fleet leader can't swallow the title."""
    if not isinstance(g, dict):
        return ''
    fleets = (g.get('self') or {}).get('fleets')
    if not isinstance(fleets, list) or not fleets:
        return ''
    chips = []
    for f in fleets[:4]:
        if not isinstance(f, dict):
            continue
        label = str(f.get('label') or f.get('slug') or '').strip()
        if not label:
            continue
        if len(label) > 16:
            label = label[:15] + '…'
        glyph = '👑' if f.get('role') == 'leader' else '👤'
        square = str(f.get('square') or '').strip()
        chips.append(f'{glyph} {label}{(" " + square) if square else ""}')
    if not chips:
        return ''
    seg = ' · '.join(chips)
    more = len(fleets) - len(chips)
    if more > 0:
        seg += f' +{more}'
    return seg


def term_title(g, model_tag=''):
    """The OSC terminal-title string — LEADS with the fleet chips (👑/👤 + name + colour square per fleet,
    the multi-fleet identity, WI-1963), then the loop chip (the surfaced autonomy signal: present ⇒ a loop
    is armed, absent ⇒ none), the model·effort tag (so the titlebar always shows which model + settings
    this terminal is on), the session shorthand id, and a clipped objective. '' when there's nothing
    meaningful (skip the write)."""
    me_id = self_short(me)
    bits = []
    fl = fleets_part(g)
    if fl:
        bits.append(fl)
    lp = (g.get('self') or {}).get('loop') if isinstance(g, dict) else None
    if isinstance(lp, dict) and lp.get('active'):
        # WI-655: trailing '!' on the title loop chip when the loop is armed but not wake-reachable.
        tag = f'⟳{fmt_interval(lp.get("intervalSec"))}'
        if lp.get('reachable') is False:
            tag += '!'
        bits.append(tag)
    if model_tag:
        bits.append(model_tag)
    if me_id:
        bits.append(me_id)
    obj = (g.get('self') or {}).get('objective') if isinstance(g, dict) else None
    if isinstance(obj, str) and obj.strip():
        o = obj.strip()
        bits.append(o[:40] + ('…' if len(o) > 40 else ''))
    return ' · '.join(bits)


def set_title(title):
    """Write the OSC-0 terminal title to the terminal THIS SESSION OWNS (never via Claude's
    stdout, which it captures as the statusline body). Fail-open: no owned terminal → skip.

    WI-3665: this used to open '/dev/tty' — the CONTROLLING terminal — which Claude Code has
    never given us. It spawns the statusLine command setsid'd (its own session, tty=?), so the
    open raised ENXIO on every tick and the title write silently no-opped for the entire life
    of this hook. pc_tty.write_osc_title prefers PAPERCUSP_TTY (the owning terminal, resolved
    at launch by psu-launcher and inherited through the setsid boundary) and falls back to
    /dev/tty for hooks that DO keep a controlling terminal. See pc_tty.py for why we resolve
    ownership at launch instead of walking /proc ancestry."""
    if not title:
        return
    # Test seam: a real terminal is NOT captured by the fixture-mode test harness, so when
    # PAPERCUSP_STATUSLINE_TITLE_OUT names a file we also record the computed title there —
    # the only way to assert the title RENDER (vs. the write). Unset in production → no-op.
    # Note it records the bare title; PAPERCUSP_TTY captures the wire-level OSC escape.
    title_out = os.environ.get('PAPERCUSP_STATUSLINE_TITLE_OUT')
    if title_out:
        try:
            with open(title_out, 'w') as fh:
                fh.write(''.join(c for c in title if ord(c) >= 32 and c not in '\x07\x1b'))
        except Exception:
            pass
    # Keep the tty ownership check aligned with the same resolved owner used for
    # the glance request. A stale ambient SID must not make a valid title write
    # look like a foreign claim on the owned terminal.
    write_osc_title(title, env={**os.environ, 'PAPERCUSP_SID': me})


def lead():
    """Line-1 prefix segments: this agent's own ◇ id chip (◇ = self, paired with ◆ = most-recent
    peer), and — when the gateway knows it — ⇢ <account>, the pool account that served this session's
    most-recent turn. Both render paths share it. The 🔭 objective segment (objective_part) is prepended
    by the caller ahead of these, so it leads line 1. (The static 'papercusp' label was removed
    2026-07-03 at owner request — it only ate line width; the ◇ id already identifies the pane.)"""
    me_id = self_short(me)
    parts = [f'◇ {me_id}'] if me_id else []
    acct = routed_account(me)
    if acct:
        parts.append(f'⇢ {acct}')
    return parts


def emit(lines, cols):
    sys.stdout.write('\n'.join(l[:cols] for l in lines if l))


cols = 120
try:
    cols = max(40, int(os.environ.get('COLUMNS') or 120))
except Exception:
    pass

glance = None
try:
    if fixture:
        with open(fixture) as f:
            glance = json.load(f)
    else:
        glance = get_glance()
except Exception:
    glance = None

# 🧠 model chip / OS-title model tag — REMOVED 2026-07-03 (owner directive, WI-2124). A model that's
# always correct across every backend needs schema work not worth doing, and a possibly-stale/incorrect
# model is worse than showing none. So the statusline body + OS title carry NO model. The helper fns
# (model_bits / _compact_model / model_chip / model_title / _same_family / _user_settings /
# _session_json) stay DEFINED above for a trivial re-enable if a reliable cross-backend source lands.
# The 4 usage sites (`if mchip: parts.append(mchip)` ×2, `set_title(term_title(..., mtitle))` ×2)
# no-op naturally: mchip falsy ⇒ never appended; mtitle '' ⇒ term_title's `if model_tag` skips it.
mchip = None
mtitle = ''

# ── SINGLE-SOURCE display render (tui-status-parity-single-source-2026-07-05) ──
# When the operator ships a server-rendered `display` block on the glance
# (status-display.ts — ONE render feeding every TUI), this hook is a DUMB PIPE:
# print display.statusline verbatim (width-fitting only — emit() clips chip rows
# to COLUMNS; 💡 tip rows WRAP so a tip is never lost) and mirror display.title
# into the OS title. The per-client assembly below survives ONLY as the fallback
# for a pre-display operator; do NOT add chips there — add them server-side.
disp = glance.get('display') if isinstance(glance, dict) else None
if isinstance(disp, dict) and isinstance(disp.get('statusline'), list) and disp.get('statusline'):
    out = []
    for raw in disp['statusline']:
        if not isinstance(raw, str) or not raw.strip():
            continue
        if raw.startswith('💡'):
            out.extend(textwrap.wrap(raw, width=cols, subsequent_indent='  ')[:4])
        else:
            out.append(raw)
    dtitle = disp.get('title')
    if isinstance(dtitle, str) and dtitle.strip():
        set_title(dtitle.strip())
    else:
        set_title(term_title(glance, mtitle))
    emit(out, cols)
    sys.exit(0)

if not isinstance(glance, dict) or 'wake' not in glance:
    # No parseable glance. Fixture mode: an activity-shaped payload (no 'wake'
    # key) exercises the legacy single-line render below — stays testable.
    # LIVE mode: NO second network call. The old `activity:recent` fallback
    # existed for the pre-deploy window before coord:glance shipped
    # (2026-06-12); once the TOON result-format default landed, json.loads()
    # failed on every glance response and this branch silently DOUBLED the
    # statusline's MCP traffic fleet-wide while rendering the degraded legacy
    # line (EI-7029). call_tool now pins format=json, so an unparseable glance
    # means operator trouble — fail open and render nothing, per the header
    # contract.
    if not fixture:
        sys.exit(0)
    data = glance if isinstance(glance, dict) else None
    rows = (data or {}).get('activity')
    if not isinstance(rows, list) or not rows:
        sys.exit(0)
    n, peer = peer_glance(rows)
    # objective_part(glance) is None here (the legacy activity payload carries no
    # self.objective) — but prepend through the same path so the 🔭 segment leads
    # whenever the field IS present, with no special-casing.
    obj = objective_part(glance)
    parts = ([obj] if obj else []) + lead()
    if mchip:
        parts.append(mchip)
    parts.append(f'{n} peer{"" if n == 1 else "s"}' if n else 'solo')
    if peer is not None:
        p = peer_part(peer)
        if p:
            parts.append(p)
    set_title(term_title(glance if isinstance(glance, dict) else {}, mtitle))
    emit([' · '.join(parts)], cols)
    sys.exit(0)

# ── glance render (two lines) ──
wake = glance.get('wake') or {}
bees = (glance.get('bees') or {}).get('running') or 0
gov = glance.get('governor') or {}
tips = glance.get('tips') or []
n, peer = peer_glance(glance.get('activity'))

# 🔭 <objective> LEADS line 1 — what THIS terminal is working on, ahead of the
# fleet shorthand. None (absent/blank/old-operator) → segment simply omitted.
obj = objective_part(glance)
parts = ([obj] if obj else []) + lead()
# ⟳ <interval> loop chip — surfaces that THIS session is on an engine loop (loop:arm) right after
# the self id, so the human sees the autonomy cadence at a glance (loop-status-display-2026-06-23).
lpchip = loop_part(glance)
if lpchip:
    parts.append(lpchip)
# ▣ <modes> — the session's OFFICIAL standing modes (agent_modes / EI-7626), right
# after the loop cadence so the autonomy state reads as one cluster.
modeschip = modes_part(glance)
if modeschip:
    parts.append(modeschip)
# ctx N% — this session's ambient context-usage gauge (agent-managed-compaction P-015),
# ⚠-prefixed ≥80% so an approaching compaction is visible in the bottom line every tick.
ctxchip = context_part(glance)
if ctxchip:
    parts.append(ctxchip)
# 🧠 <model>·<effort> — the model + settings (e.g. opus[1m]·xhigh) this terminal is running on.
if mchip:
    parts.append(mchip)
mode = wake.get('default')
staged = wake.get('stagedTotal') or 0
if mode in ('auto', 'manual'):
    glyph = '▶ auto' if mode == 'auto' else '⏸ manual'
    parts.append(glyph + (f' ✉{staged}' if staged else ''))
if bees:
    parts.append(f'☕{bees}')
if gov.get('anyPaused'):
    keys = ','.join(p.get('key', '?') for p in (gov.get('paused') or []))
    parts.append(f'⏳ {keys}'[:40])
parts.append(f'{n} peer{"" if n == 1 else "s"}' if n else 'solo')
if peer is not None:
    p = peer_part(peer)
    if p:
        parts.append(p)

lines = [' · '.join(parts)]
if tips:
    tip = tips[0]
    text = (tip.get('text') or '').strip()
    cmd = (tip.get('command') or '').strip()
    if text:
        # WRAP the tip across rows rather than truncating — the statusline has
        # no expand affordance, so a clipped tip is a lost tip. Long unbroken
        # tokens (the slash command) split rather than vanish. Capped so a
        # pathological tip can't swallow the pane.
        full = ('💡 ' + text + (f' {cmd}' if cmd else '')).rstrip()
        lines.extend(textwrap.wrap(full, width=cols, subsequent_indent='  ')[:4])
        # A statusline can't expand, and line 1 clips the governor list + peer
        # summary to fit — so whenever there's a tip worth surfacing, point at
        # the full structured glance the human can run for the unabridged state.
        lines.append('⋯ run /mcp__papercusp-su__tool:coord:glance for detail')
# Mirror the loop/objective state into the OS terminal title (written straight to /dev/tty so it
# bypasses Claude's stdout capture). Refreshed every statusline tick, so it tracks loop arm/end.
set_title(term_title(glance, mtitle))
emit(lines, cols)
PYEOF
