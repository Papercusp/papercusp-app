#!/usr/bin/env bash
# PostToolUse hook — the Codex STATUS-DISPLAY pipe: terminal TITLE + 💡 tip notice
# (session-objective-display-2026-06-22 P-003/P-004; WI-1963 full title parity;
# SINGLE-SOURCE rework tui-status-parity-single-source-2026-07-05). Codex has no
# bottom status pane (that's a Claude-Code-only TUI feature), but it DOES own a
# tty and consumes PostToolUse `additionalContext` — so this hook surfaces the
# fleet status through BOTH:
#
#   1. TITLE — an OSC-0 escape (ESC ] 0 ; <title> BEL) carrying the glance's
#      server-rendered `display.title` VERBATIM (status-display.ts — the ONE
#      render every TUI shows: fleets 👑/👤 + colour squares · ⟳loop · ▶/⏸✉staged ·
#      ☕bees · ⏳governor · peers · id · 🔭objective). New chips belong in
#      status-display.ts, NOT here; the embedded `term_title` assembly below is
#      only the fallback for a pre-display operator.
#   2. 💡 NOTICE — the glance's `display.notice` (the top contextual tip, e.g.
#      "Wake mode is manual — 4 staged wakes waiting"), injected as PostToolUse
#      additionalContext when it CHANGES (a per-session cursor file dedups), so a
#      codex session gets the same tips the Claude statusline shows. Disable with
#      PAPERCUSP_TIP_NOTICE=0.
#
# The title escape goes to the TTY directly (/dev/tty), NOT stdout — hook stdout
# is reserved for the additionalContext JSON (the harness consumes it; a title
# written there would corrupt the tool result).
#
# CACHE-ONLY + FAIL-OPEN: posttooluse-activity-report.sh runs first and stores
# the last complete coord:glance snapshot in the existing per-owner activity
# cursor. This hook reads that file and performs ZERO network calls. Missing or
# corrupt cache degrades to the embedded bare title; a stale cache remains a
# usable stale title while the activity hook retries its bounded refresh.
# PAPERCUSP_OBJECTIVE_SYNC remains an accepted no-op env for back-compat.
#
# Scope guard: runs ONLY in a psu session (PAPERCUSP_SID set). A plain codex/omp
# elsewhere has no PAPERCUSP_SID and bails instantly; the cache-only consumer no
# longer needs a token because it never contacts the operator.

set -euo pipefail

# psu-session gate. In test mode a glance-shaped payload in
# $PAPERCUSP_OBJECTIVE_FIXTURE drives the render with no activity cache.
if [ -z "${PAPERCUSP_OBJECTIVE_FIXTURE:-}" ]; then
  if [ -z "${PAPERCUSP_SID:-}" ]; then
    exit 0
  fi
fi

# Drain stdin (the PostToolUse event JSON) so the pipe closes cleanly; we key off
# the env + coord:glance, not the tool payload.
INPUT="$(cat 2>/dev/null || true)"

# Where the title escape goes. The client owns the tty; default to /dev/tty (the
# controlling terminal of the codex/omp process tree). Overridable for tests.
TITLE_TTY="${PAPERCUSP_OBJECTIVE_TTY:-/dev/tty}"

# PostToolUse payloads can include a large tool result. Extract the only field
# the identity resolver needs through stdin and pass the bounded native id to
# the renderer, rather than copying the full JSON into argv (ARG_MAX).
NATIVE_SESSION_ID="$(printf '%s' "$INPUT" | python3 -c 'import json,sys; p=json.load(sys.stdin); v=p.get("session_id") if isinstance(p, dict) else ""; print(v if isinstance(v, str) else "")' 2>/dev/null)" || NATIVE_SESSION_ID=""

# Read the cached glance and (when present + non-blank) write the OSC-0 title
# escape DIRECTLY to the tty from python — the title IO lives in python (the
# activity-hook pattern), NOT in a fragile `$(...)`-around-heredoc command
# substitution. The `|| true` call site keeps any crash fail-open.
set_title() {
  python3 - "${PAPERCUSP_SID:-fixture}" "${PAPERCUSP_OBJECTIVE_FIXTURE:-}" "$TITLE_TTY" "${PAPERCUSP_MODEL:-}" "$NATIVE_SESSION_ID" "$(dirname "$0")" <<'PYEOF'
import json, os, re, sys

me, fixture, title_tty = sys.argv[1:4]
model_spec = sys.argv[4] if len(sys.argv) > 4 else ''  # PAPERCUSP_MODEL launch spec — codex/omp have no live model object
stdin_raw = sys.argv[5] if len(sys.argv) > 5 else ''  # bounded native session_id extracted from PostToolUse
# Shared tty resolution (WI-3665) — see pc_tty.py. Sits beside this script in both the
# repo and the installed runtime dir, so $0's dirname resolves it either way.
sys.path.insert(0, sys.argv[6] if len(sys.argv) > 6 else os.path.dirname(os.path.abspath(__file__)))
from pc_tty import coordination_owner_id, write_osc_title  # noqa: E402  (path must be primed first)
me = coordination_owner_id(stdin_raw, os.environ)


def read_cached_glance():
    cache_dir = os.environ.get('PAPERCUSP_LOCKS_CACHE_DIR') or os.path.join(
        os.path.expanduser('~'), '.papercusp', 'locks-cache')
    safe_owner = re.sub(r'[^A-Za-z0-9._-]', '_', me)[:120]
    cache_path = os.path.join(cache_dir, f'activity-hook-bundle-{safe_owner}.json')
    try:
        with open(cache_path) as f:
            state = json.load(f)
        glance = state.get('glance') if isinstance(state, dict) else None
        return glance if isinstance(glance, dict) else None
    except Exception:
        return None


# ── Title assembly — kept BYTE-IDENTICAL to statusline-fleet.sh's term_title so a codex/omp
#    title and a Claude title render the SAME for the same glance + model (WI-1963 full title
#    parity). Guarded by objective-title-parity.test.ts (a drift there fails CI). The Claude
#    side sources the model from its LIVE stdin object; this side from the launch spec env —
#    but the RENDER (term_title) is one shared shape. ──
def self_short(owner):
    owner = str(owner or '').strip()
    if not owner or owner == 'fixture':
        return ''
    bits = owner.split('-')
    if len(bits) >= 2 and bits[1]:
        return f'{bits[0]}-{bits[1][:5]}'
    return owner[:8]


def fmt_interval(sec):
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


def fleets_part(g):
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


def _compact_model(*names):
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


def model_title(label, effort):
    return '/'.join(x for x in (label, effort) if x)


def model_tag_from_spec(spec):
    """Compact model tag ('opus[1m]/xhigh') from the psu --model SPEC (e.g. 'opus[1m]:xhigh').
    Mirrors the Claude statusline's model_title(_compact_model(display_name/id), effort) so both
    CLIs render the SAME tag — the Claude side sources the model from its live stdin object, the
    codex/omp side from the launch spec env, but the model RENDER is identical."""
    s = str(spec or '').strip()
    if not s:
        return ''
    c = s.rfind(':')
    effort = ''
    base = s
    if c > 0 and s[c + 1:] in ('low', 'medium', 'high', 'xhigh', 'max'):
        effort = s[c + 1:]
        base = s[:c]
    return model_title(_compact_model(base), effort)


def term_title(g, model_tag=''):
    me_id = self_short(me)
    bits = []
    fl = fleets_part(g)
    if fl:
        bits.append(fl)
    lp = (g.get('self') or {}).get('loop') if isinstance(g, dict) else None
    if isinstance(lp, dict) and lp.get('active'):
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


def emit_notice(disp):
    """💡 tip-notice injection (tui-status-parity-single-source-2026-07-05 P-003, codex leg):
    when the glance's server-rendered display.notice CHANGES (id+text vs a per-session
    cursor file), print the PostToolUse additionalContext JSON so the harness injects it —
    the codex equivalent of the Claude statusline's 💡 line. First run SHOWS a standing
    notice once (a manual wake gate is worth one surfacing at session start), then the
    cursor dedups. Fail-open: any trouble ⇒ no output. PAPERCUSP_TIP_NOTICE=0 disables."""
    if os.environ.get('PAPERCUSP_TIP_NOTICE', '1') == '0':
        return
    notice = disp.get('notice') if isinstance(disp, dict) else None
    if not isinstance(notice, dict):
        return
    text = str(notice.get('text') or '').strip()
    if not text:
        return
    key = f'{notice.get("id") or "tip"}|{text}'
    cache_dir = os.environ.get('PAPERCUSP_LOCKS_CACHE_DIR') or os.path.join(
        os.path.expanduser('~'), '.papercusp', 'locks-cache')
    safe_owner = re.sub(r'[^A-Za-z0-9._-]', '_', me)[:80]
    cursor_path = os.path.join(cache_dir, f'tip-notice-{safe_owner}.json')
    try:
        with open(cursor_path) as f:
            if (json.load(f) or {}).get('key') == key:
                return  # unchanged — already surfaced
    except Exception:
        pass  # no cursor yet — first surfacing
    try:
        os.makedirs(cache_dir, mode=0o700, exist_ok=True)
        tmp = f'{cursor_path}.{os.getpid()}.tmp'
        with open(tmp, 'w') as f:
            json.dump({'key': key}, f)
        os.replace(tmp, cursor_path)
    except Exception:
        pass  # cursor write failed — worst case the notice repeats; still emit
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PostToolUse',
            'additionalContext': (
                '<system-reminder type="papercusp-status-tip">'
                + text
                + ' (fleet status tip — act on it or surface it to the user; coord:glance for detail)'
                + '</system-reminder>'
            ),
        },
    }))


try:
    glance = None
    try:
        if fixture:
            with open(fixture) as f:
                glance = json.load(f)
        else:
            glance = read_cached_glance()
    except Exception:
        glance = None

    # SINGLE-SOURCE title (tui-status-parity-single-source-2026-07-05): pipe the
    # server-rendered display.title VERBATIM when the operator ships it — the ONE
    # render every TUI shows. The embedded term_title assembly survives ONLY as
    # the fallback for a pre-display operator (WI-1963 parity era); new chips go
    # in status-display.ts, not here. Model display REMOVED 2026-07-03 (owner
    # directive, WI-2124): better none than a possibly-stale model.
    disp = glance.get('display') if isinstance(glance, dict) else None
    dtitle = disp.get('title') if isinstance(disp, dict) else None
    if isinstance(dtitle, str) and dtitle.strip():
        title = dtitle.strip()
    else:
        title = term_title(glance)
    # Shared write (WI-3665): PAPERCUSP_OBJECTIVE_TTY (this hook's test seam) →
    # PAPERCUSP_TTY (the owning terminal, survives a setsid'd spawn) → /dev/tty (the
    # controlling terminal, which Codex's child hooks still have). Control chars are
    # stripped inside. A piped/headless session matches nothing → fail open, no title.
    # Keep the tty ownership check aligned with the resolved coordination owner
    # used for the glance request; a stale ambient SID must not reject our own
    # terminal claim after a client self-reexec.
    write_osc_title(
        title,
        env={**os.environ, 'PAPERCUSP_SID': me},
        extra_first=('PAPERCUSP_OBJECTIVE_TTY',),
    )
    # 💡 tip notice — stdout is reserved for this additionalContext JSON.
    emit_notice(disp)
except Exception:
    sys.exit(0)
PYEOF
}

# ALWAYS synchronous with stdout passed through: stdout carries the tip-notice
# additionalContext JSON the harness consumes (a detached/redirected run would
# silently drop it — the pre-2026-07-05 behavior). stderr stays silenced; any
# failure exits 0 (fail-open, never blocks the tool stream).
set_title 2>/dev/null || true
exit 0
