"""pc_tty — resolve the terminal a papercusp hook's OSC-0 title write belongs to.

WHY THIS EXISTS (WI-3665, 2026-07-09). Every papercusp CLI hook renders the
fleet identity (👑 leader / 👤 member + fleet name + colour square) into the OS
terminal title via an OSC-0 escape. Historically each hook opened `/dev/tty` —
the process's CONTROLLING terminal. That silently stopped working on Claude
Code, which spawns the `statusLine` command in its OWN SESSION (setsid'd):

    pid=853874 ppid=853873 sid=853873 tty=?
      /dev/tty  -> ENXIO (no controlling terminal)

A setsid'd child has no controlling terminal, so the open failed, the hook
failed open (by design), and the title write was a silent no-op on EVERY tick
for as long as that spawn mode has existed. The title was computed correctly the
whole time — it just never landed. Nothing detected it because "fail open" and
"succeeded" look identical from outside.

WHY NOT WALK /proc ANCESTRY. The obvious fix — climb the parent chain to the
first ancestor with a controlling tty (`/proc/<pid>/stat` field 7 → tty_nr →
major 136 = /dev/pts/<minor>) — WORKS, and was verified to work. It is also
WRONG, because process ancestry crosses ownership boundaries. Measured on this
box: a bash under one agent's session walks up to `claude tty_nr=34881` =
/dev/pts/65, a DIFFERENT agent's terminal. A headless bee spawned by an operator
that was itself started from a dev terminal would happily retitle that dev
terminal. A title write must only ever touch a terminal this session OWNS.

THE RULE. Terminal ownership is knowable exactly once — at launch, by the
process that attaches the agent to the terminal. `psu-launcher` resolves its own
tty and exports it as `PAPERCUSP_TTY`; every descendant (including a setsid'd
statusline child, which still inherits the ENV) reads it back from here. No
guessing, no walking, no chance of writing to a window we don't own.

Consumed by `statusline-fleet.sh` (Claude) and `posttooluse-objective-title.sh`
(Codex). The OMP twin lives in `hooks/omp/coord-hook.ts` (`ttyCandidates` /
`writeOscTitle`) and is held in lockstep by objective-title-parity.test.ts.

Everything here is FAIL-OPEN: a title is cosmetic and must never break a hook,
a tool call, or a turn.

CLAIM CHECK (EI-10377, 2026-07-12/13). PAPERCUSP_TTY is a device PATH, resolved
ONCE at launch. A Linux pty's minor number is recycled once its old holder closes
it, and the path alone can't tell a recycled terminal from the one we were given —
so a session that keeps firing hooks after its OWN window is gone (an orphaned
hook process, a fleet loop still warm past its xterm being killed) can silently
retitle a totally unrelated, currently-live session's terminal that happens to
have been handed the same recycled pts number. `psu-launcher.claimTtyOwnership`
stamps a small marker file per terminal path, naming the session that currently
owns it, on every launch that resolves one — so a later launch on a recycled path
always overwrites the stale claim. `tty_owned_by_us` below checks that marker
before a PAPERCUSP_TTY write; a claim naming someone else is treated exactly like
a closed terminal (skip to the next candidate). No claim on record (older psu
build, or the registry directory is unreadable) fails OPEN, matching the
pre-existing behavior for a session that predates this check.
"""

import json
import os
import re

__all__ = [
    'strip_control',
    'coordination_owner_id',
    'tty_candidates',
    'tty_owned_by_us',
    'osc_title',
    'write_osc_title',
]


def coordination_owner_id(input_raw='', env=None):
    """Resolve the coordination owner for a hook invocation.

    ``PAPERCUSP_SID`` is the normal source, but a Claude self-reexec can rebuild
    that environment value while the native session and coordination row retain
    their original owner. Claude hook payloads include the native ``session_id``;
    psu-launcher records its born owner in the durable per-session index. Prefer
    that binding, then the adv-session binding, and finally fall back to the
    ambient SID for older launches or non-psu callers.

    This is deliberately fail-open: a cosmetic title/inbox hook must keep
    working when the index is absent, unreadable, or malformed.
    """
    env = os.environ if env is None else env
    fallback = (env.get('PAPERCUSP_SID') or '').strip()
    native_id = ''
    raw_input = str(input_raw or '').strip()
    try:
        payload = json.loads(raw_input)
        if isinstance(payload, dict):
            raw = payload.get('session_id')
            if isinstance(raw, str):
                native_id = raw.strip()
    except Exception:
        pass
    # The objective-title hook extracts the bounded session_id before invoking
    # Python so a large PostToolUse payload cannot hit the OS argv limit. Keep
    # accepting the id directly as well as the full JSON form used by statusline.
    if not native_id and raw_input and not raw_input.startswith(('{', '[')):
        native_id = raw_input

    keys = []
    if native_id:
        keys.append(native_id)
        # The adv-session binding is a useful second key only when this hook
        # invocation identified a native session. Without that payload, using
        # an ambient adv id would override an explicit fixture/non-Claude SID.
        adv_id = (env.get('PAPERCUSP_ADV_SESSION_ID') or '').strip()
        if adv_id:
            keys.append(f'adv-{adv_id}')

    root = (env.get('PAPERCUSP_SESSION_OWNERS_DIR') or '').strip()
    if not root:
        root = os.path.join(os.path.expanduser('~'), '.papercusp', 'psu-session-owners')
    for key in keys:
        # Native session ids are UUIDs and adv ids are numeric. Refuse path-like
        # input even though this is a local hook, so a malformed event cannot
        # make the title reader escape the owner-index directory.
        if not key or os.path.basename(key) != key:
            continue
        try:
            with open(os.path.join(root, key)) as fh:
                parsed = json.load(fh)
            owner = parsed.get('ownerId') if isinstance(parsed, dict) else None
            if isinstance(owner, str) and owner.strip():
                return owner.strip()
        except Exception:
            continue
    return fallback


def _tty_claims_dir(env):
    override = (env.get('PAPERCUSP_TTY_CLAIMS_DIR') or '').strip()
    return override or os.path.join(os.path.expanduser('~'), '.papercusp', 'tty-claims')


def _tty_claim_filename(tty_path):
    return re.sub(r'[^a-zA-Z0-9]+', '_', tty_path).lstrip('_')


def tty_owned_by_us(path, sid, env=None):
    """Does the CURRENT claim on terminal `path` still name our own session `sid`?

    See the module docstring's CLAIM CHECK section. No sid, no claims dir entry,
    or an unreadable claim file ⇒ True (fail open) — a title is cosmetic and a
    missing claim must never turn into a hard failure.
    """
    if not sid:
        return True
    env = os.environ if env is None else env
    claim_path = os.path.join(_tty_claims_dir(env), _tty_claim_filename(path))
    try:
        with open(claim_path) as fh:
            claimed_by = fh.read().strip()
    except Exception:
        return True  # no claim on record — fail open, as before this check existed
    return claimed_by == sid


def strip_control(title):
    """Drop control chars that could break out of the OSC string.

    The server render (status-display.ts) already strips these; this guards a
    buggy `display.title`, the legacy per-hook fallback renders, and any future
    caller. Kept identical to the TS twin's filter so titles stay byte-identical
    across CLIs.
    """
    return ''.join(c for c in str(title or '') if ord(c) >= 32 and c not in '\x07\x1b')


def tty_candidates(env=None, extra_first=()):
    """Ordered terminal paths to try, most authoritative first.

    1. `extra_first` — the caller's own test seam (e.g. PAPERCUSP_OBJECTIVE_TTY),
       so a test can capture the escape in a temp FILE instead of a real tty.
    2. `PAPERCUSP_TTY` — the owning terminal, resolved at launch by psu-launcher
       and inherited through every intermediate process, setsid'd or not. This is
       the ONLY entry that survives Claude's detached statusline spawn.
    3. `/dev/tty` — the controlling terminal. Correct for hooks that kept one
       (Codex's child hooks, OMP's in-process hook) and for a plain `claude` run
       outside psu. Harmless when absent: the open just fails.

    A stale/unopenable candidate is skipped, not fatal — hence a LIST, not a
    single answer. Terminals close; a session outliving its window must not start
    throwing.
    """
    env = os.environ if env is None else env
    out = []
    for name in extra_first:
        val = (env.get(name) or '').strip()
        if val:
            out.append(val)
    owned = (env.get('PAPERCUSP_TTY') or '').strip()
    if owned:
        out.append(owned)
    out.append('/dev/tty')
    return out


def osc_title(title):
    """The OSC-0 set-title escape, or '' when there's nothing safe to write.

    OSC 0 sets BOTH the icon name and the window title: ESC ] 0 ; <text> BEL.
    """
    clean = strip_control(title)
    return '\033]0;{}\007'.format(clean) if clean else ''


def write_osc_title(title, env=None, extra_first=()):
    """Set the terminal title. Returns True if some terminal accepted the write.

    Tries each candidate in order and stops at the first success. Returns False
    when every candidate fails (headless session, closed terminal, no tty
    anywhere) — the caller ignores the result; a title is cosmetic.

    EI-10377: the PAPERCUSP_TTY candidate specifically is skipped when its claim
    (see tty_owned_by_us) now names a different session — a recycled pty must
    never be clobbered just because our stale env var still spells its old path.
    """
    osc = osc_title(title)
    if not osc:
        return False
    env = os.environ if env is None else env
    sid = (env.get('PAPERCUSP_SID') or '').strip()
    owned_path = (env.get('PAPERCUSP_TTY') or '').strip()
    for path in tty_candidates(env, extra_first):
        if path == owned_path and not tty_owned_by_us(path, sid, env):
            continue  # the claim on this path has moved to a different session
        try:
            with open(path, 'w') as fh:
                fh.write(osc)
                fh.flush()
            return True
        except Exception:
            continue  # stale seam / closed terminal / no tty — try the next
    return False
