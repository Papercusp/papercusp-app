#!/usr/bin/env bash
# Claude hook — the owner-gate CAPTURE + MIRROR layer (P-001 of
# owner-inbox-single-pane-2026-07-17). One script, FOUR hook_event_name
# branches (same combined-script shape as workitem-verify-nudge.sh), each
# registered as its own settings.json entry:
#
#   • PreToolUse  (matcher "AskUserQuestion|ExitPlanMode") — the dialog is
#     about to open: mirror question+options into the client-agnostic
#     blocked-session tracker (sessions:ingest-gate-event, P-002) so the
#     Inbox sees "this session is waiting on you" the moment the tool
#     dispatches, tagged with the asking session + owner. refId = the
#     native tool_use_id, so PostToolUse can close the SAME row.
#   • PostToolUse (same matcher) — the dialog closed (Claude only reaches
#     PostToolUse once it has a tool_result): auto-resolve the mirror
#     (kind:'cleared', same refId). Content of the answer is irrelevant here
#     — P-006 already wires the reply-routing side for answers that came
#     FROM the inbox; this is just closing the "still waiting" signal.
#   • Notification — Claude's generic notification channel. When the
#     message names a PERMISSION wait ("Claude needs your permission…"),
#     open a 'permission_wait' gate keyed on a fixed per-session refId
#     (`notify:<session_id>`) — idempotent-touch on repeats. Every OTHER
#     notification shape is ignored here (P-002's transcript watcher is the
#     general-purpose "no tool_result yet" detector; this is a fast-path
#     nicety for the one Claude-specific shape a watcher can't see faster).
#   • Stop — the ask-mirror + BOUNCE. First, best-effort-clear the
#     `notify:<session_id>` gate opened above (a turn ending means any
#     mid-turn permission wait is moot by construction). Then read the
#     turn's OWN final assistant text out of the transcript and:
#       1. an `<ask>{...}</ask>` tag (the @papercusp/chat-protocol P-003
#          AskBlock wire shape, parsed here with a python port of the same
#          validation contract — question required, options/refs optional,
#          malformed → ignored) → mirror it to `coord:escalate` (D-001's
#          preferred ask surface: a real card, answerable from the inbox)
#          and ALLOW the stop.
#       2. no `<ask>` tag, but the ending is QUESTION-SHAPED (last non-blank
#          line, ≤300 chars, ends in "?", not a code fence / quote line) →
#          BOUNCE: print `{"decision":"block","reason":…}` teaching the
#          agent to re-emit its ending through the NATIVE AskUserQuestion tool
#          (preferred — a real terminal dialog that this hook's PreToolUse
#          branch already mirrors to the Inbox) or coord:escalate, and NOT as a
#          raw <ask> text tag (which a TUI renders as unreadable XML — owner
#          flag 2026-07-19, inbox-pane-active-scope-dates-filters). NARROW (see
#          question_shaped_ending)
#          and LOOP-GUARDED: Claude sets `stop_hook_active:true` on the
#          hook-triggered continuation that follows a block — we check it
#          FIRST and never bounce twice in the same turn no matter what the
#          re-emitted ending looks like.
#       3. no <ask>, but the ending CLAIMS an imminent action ("Compacting now")
#          without a tool call in the current turn → BOUNCE: the assertion is not
#          an action, and silently ending here strands the session.
#       4. neither → allow, empty stdout, exactly like every sibling Stop
#          hook in this directory.
#
# Deliberately SYNCHRONOUS (unlike the per-tool-call activity/lock hooks,
# which MUST be fire-and-forget because they run on every single tool call):
# every branch here fires on a rare, already-pausing event — a structured
# dialog opening/closing, a permission notification, or once per turn at
# Stop — so a bounded few-second HTTP round trip is imperceptible, and Stop
# in particular MUST run synchronously anyway (its JSON decision has to
# reach stdout before the hook process exits). Every network call is
# wrapped fail-open: an unreachable/slow operator costs nothing beyond its
# own timeout and NEVER blocks the turn or corrupts stdout.
#
# Scope guard: runs ONLY in a psu session (PAPERCUSP_SID + su-token present),
# exactly like every other cc/ hook; a plain claude session elsewhere has no
# PAPERCUSP_SID and bails before reading stdin (EPIPE-safe — see
# __tests__/spawn-hook.ts's header for why the ordering matters).
#
# EI-14208: the `|| exit 0` fail-open below (necessary — a hook error must
# never block the Claude Code Stop event) previously swallowed EVERY failure
# with zero trace, making "the hook ran and found nothing to mirror" and "the
# hook silently broke" indistinguishable from the outside. Two backstops now
# make a real miss inspectable: (1) the python body logs a one-line marker to
# `~/.papercusp/hooks/cc/ask-gate-mirror.errors.log` whenever a mirror call
# (sessions:ingest-gate-event / coord:escalate) ultimately fails, with a single
# retry first for the two Stop-branch calls (the ones a slow/wedged operator
# or a mid-turn race is most likely to hit); (2) the bash wrapper itself logs
# if the python process exits non-zero for any OTHER reason (e.g. a crash
# before it could log itself), closing the outer `|| exit 0`'s own blind spot.

set -euo pipefail

OPERATOR_URL="${PAPERCUSP_OPERATOR_URL:-http://localhost:3070}"
TOKEN_PATH="${HOME}/.papercusp/superuser-token"

if [ -z "${PAPERCUSP_SID:-}" ] || [ ! -s "$TOKEN_PATH" ]; then
  exit 0
fi

# WI-10004945: a claude/codex NESTED inside another agent inherited that su's
# PAPERCUSP_SID. Its dialogs and <ask> endings are not the su's: mirroring them would put
# a "su is waiting on you" card in the owner's Inbox that no answer can reach, and the
# Stop bounce would push a programmatic `claude -p` into an extra turn it never asked
# for. Skip every branch. Cached per CLI process (pc_nested_cli.sh); any failure leaves
# the condition false and the hook runs as before.
if . "$(dirname "$0")/pc_nested_cli.sh" 2>/dev/null && pc_nested_cli_cached; then
  exit 0
fi

INPUT=$(cat)

PY_STATUS=0
python3 - "$OPERATOR_URL" "$TOKEN_PATH" "$PAPERCUSP_SID" "${PAPERCUSP_HARNESS_SLUG:-}" "$(dirname "$0")" 3<<<"$INPUT" <<'PYEOF' || PY_STATUS=$?
import datetime, json, os, re, sys, time, urllib.request, urllib.parse

operator_url, token_path, owner, harness, hook_dir = sys.argv[1:6]
sys.path.insert(0, hook_dir)
from mcp_response import read_hook_payload, read_token_file, with_native_session  # noqa: E402
raw = read_hook_payload()
token = read_token_file(token_path)
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))  # localhost operator: never via egress http(s)_proxy
HTTP_TIMEOUT = 4
# Bound how much of a (possibly huge, long-running-session) transcript we
# ever read: only the tail can hold the CURRENT turn's final assistant text.
TRANSCRIPT_TAIL_BYTES = 300_000

try:
    ev = json.loads(raw)
except Exception:
    sys.exit(0)
if not isinstance(ev, dict):
    sys.exit(0)


def first(*keys):
    for k in keys:
        v = ev.get(k)
        if v not in (None, ''):
            return v
    return None


def truthy(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in ('1', 'true', 'yes')
    return bool(v)


name = (first('hook_event_name', 'hookEventName') or '').strip()
session_id = first('session_id', 'sessionId') or ''
tool_name = first('tool_name', 'toolName') or ''
tool_input = first('tool_input', 'toolInput')
if not isinstance(tool_input, dict):
    tool_input = {}
tool_use_id = first('tool_use_id', 'toolCallId', 'tool_call_id') or ''

GATE_TOOLS = ('AskUserQuestion', 'ExitPlanMode')


def log_failure(context, detail=''):
    """EI-14208: best-effort append a one-line failure marker so a mirror call
    that fails (even after its retry) is inspectable AFTER the fact, instead of
    indistinguishable from "the hook ran and legitimately found nothing to
    mirror". Must never raise, block, or touch stdout — this is pure
    observability for a fail-open path."""
    try:
        log_dir = os.path.join(os.path.expanduser('~'), '.papercusp', 'hooks', 'cc')
        os.makedirs(log_dir, exist_ok=True)
        ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        line = f'{ts} session={session_id or "?"} hook={name or "?"} {context}: {detail}'
        with open(os.path.join(log_dir, 'ask-gate-mirror.errors.log'), 'a', encoding='utf-8') as f:
            f.write(line.replace('\n', ' ')[:2000] + '\n')
    except Exception:
        pass


def call_tool(tool, args, timeout=HTTP_TIMEOUT, retries=0, label=None):
    """POST one MCP tool call; return its parsed JSON result, or None on any
    failure (network, timeout, tool error, malformed response) — never raises.

    EI-14208: on request failure, retries up to `retries` more times (a short
    fixed 150ms gap, and a capped 2s timeout on the retry attempt so a single
    slow call can't silently double the hook's worst-case latency) before
    giving up; the FINAL failure (post-retry) is logged via log_failure so a
    genuine miss leaves a trace. retries=0 (the default) preserves the exact
    prior one-shot fail-open behavior, just now with a log line on failure."""
    def once(to):
        # EI-14208: Request(...) construction (URL parsing) can itself raise
        # (e.g. a malformed operator URL) — keep it INSIDE the try alongside
        # urlopen so every failure mode funnels through the same retry+log
        # path instead of crashing the whole hook process uncaught.
        try:
            body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                                'params': {'name': tool, 'arguments': args}}).encode()
            req = urllib.request.Request(
                with_native_session(
                    operator_url.rstrip('/') + '/api/mcp?superuser=1&origin=hook&client=' + urllib.parse.quote(owner, safe=''),
                    session_id),
                data=body,
                headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                         'Accept': 'application/json, text/event-stream'},
                method='POST')
            raw_resp = urllib.request.urlopen(req, timeout=to).read().decode('utf-8', 'replace')
        except Exception as e:
            return None, f'{type(e).__name__}: {e}'
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
            return None, f'isError-or-empty result={str(result)[:300]}'
        for item in (result.get('content') or []):
            if item.get('type') == 'text':
                try:
                    return json.loads(item['text']), None
                except Exception:
                    pass
        return None, 'no-parseable-content-block'

    last_err = 'unknown'
    for attempt in range(retries + 1):
        value, err = once(timeout if attempt == 0 else min(timeout, 2))
        if err is None:
            return value
        last_err = err
        if attempt < retries:
            time.sleep(0.15)
    log_failure(f'{label or tool}-failed', last_err)
    return None


# ── shared: mirror-question extraction for AskUserQuestion / ExitPlanMode ──────

def report_str(v):
    """Trim + drop empties (mirrors chat-protocol's reportStr): non-blank str, or None."""
    if not isinstance(v, str):
        return None
    t = v.strip()
    return t if t else None


def build_ask_question(name_, tool_input_):
    """Returns (question, options|None, text|None) for the PreToolUse mirror,
    or (None, None, None) when the tool's input carries nothing usable."""
    if name_ == 'AskUserQuestion':
        qs = tool_input_.get('questions')
        if not isinstance(qs, list) or not qs:
            return None, None, None
        head = qs[0]
        if not isinstance(head, dict):
            return None, None, None
        question = report_str(head.get('question')) or report_str(head.get('header'))
        if not question:
            return None, None, None
        opts = []
        raw_opts = head.get('options')
        if isinstance(raw_opts, list):
            for o in raw_opts:
                if not isinstance(o, dict):
                    continue
                label = report_str(o.get('label'))
                if not label:
                    continue
                entry = {'label': label[:200]}
                desc = report_str(o.get('description'))
                if desc:
                    entry['description'] = desc[:2000]
                opts.append(entry)
        extra = len(qs) - 1
        if extra > 0:
            question += f' (+{extra} more question{"s" if extra > 1 else ""})'
        return question[:2000], (opts or None), None
    if name_ == 'ExitPlanMode':
        plan = report_str(tool_input_.get('plan'))
        return 'Approve this plan?', None, (plan[:4000] if plan else None)
    return None, None, None


# ── shared: `<ask>` tag detection (python port of chat-protocol's AskBlock
# validation contract — kept behaviorally aligned with parseAskBlock/
# parseAskTag in libs/generic/chat-protocol/src/index.ts; a hook script can't
# import that TS module at runtime, so this mirrors its shape by hand) ────────

ASK_TAG_RE = re.compile(r'<ask>(.*?)</ask>', re.IGNORECASE | re.DOTALL)


def parse_ask_block(value):
    if not isinstance(value, dict):
        return None
    question = report_str(value.get('question'))
    if not question:
        return None
    options = None
    raw_opts = value.get('options')
    if isinstance(raw_opts, list):
        parsed = []
        for o in raw_opts:
            if not isinstance(o, dict):
                continue
            oid = report_str(o.get('id'))
            if not oid:
                continue
            label = report_str(o.get('label')) or oid
            parsed.append({'id': oid, 'label': label})
        options = parsed or None
    refs = None
    raw_refs = value.get('refs')
    if isinstance(raw_refs, list):
        parsed = [report_str(r) for r in raw_refs]
        parsed = [r for r in parsed if r]
        refs = parsed or None
    out = {'question': question}
    if options:
        out['options'] = options
    if refs:
        out['refs'] = refs
    return out


def parse_ask_tag(text):
    if not text:
        return None
    m = ASK_TAG_RE.search(text)
    if not m:
        return None
    try:
        data = json.loads(m.group(1).strip())
    except Exception:
        return None
    return parse_ask_block(data)


# ── shared: "question-shaped ending" heuristic — deliberately NARROW so a
# routine rhetorical aside never trips a bounce: only the FINAL non-blank
# line counts, it must be short (a sentence, not a code dump), and it must
# not look like a code-fence / quote line. ────────────────────────────────────

def question_shaped_ending(text):
    t = (text or '').rstrip()
    if not t:
        return False
    lines = [ln for ln in t.splitlines() if ln.strip()]
    if not lines:
        return False
    last = lines[-1].strip()
    if not last or len(last) > 300:
        return False
    if last.startswith('```') or last.startswith('>') or last.startswith('#'):
        return False
    return last.endswith('?')


# ── WI-5865: "deferred deliverable" heuristic — the failure the PreToolUse
# delivery guard CANNOT see. That guard fires when a dialog and a long report
# collide in ONE turn; this one fires when a turn ends by PROMISING content (or
# a QUESTION — EI-19412167276099357 defect 2) for a future turn and delivers
# neither ("next turn I'll put the plan in front of you" / "I'll ask how you
# want this executed in the next message"). Owner-reported 2026-07-25 after an
# su deferred a finished plan twice — two round trips for content that already
# existed; the question-deferral shape was measured live 2026-08-03 (same cost,
# a different owner turn).
#
# Deliberately narrow, because a bounce costs the fleet a turn: a sentence must
# carry ALL THREE of (1) a future-TURN marker — "next wake"/"next tick" are
# EXCLUDED, they are legitimate loop cadence — (2) a first-person future
# ("I'll" / "I will" / "let me"), and (3) a delivery/ask verb or a deliverable
# noun. So "next turn I'll re-check the gate" (real future work) does not trip
# it, while "I'll lay out the options next turn" (withheld content) and "I'll
# ask how you want this next message" (a deferred question) both do. ──────────

_DEFER_FUTURE_TURN_RE = re.compile(
    r'\bnext\s+(?:turn|message|reply|response)\b|\bfollowing\s+turn\b|\bin\s+my\s+next\s+(?:turn|message|reply|response)\b',
    re.I,
)
_DEFER_FIRST_PERSON_RE = re.compile(r"\b(?:i'?ll|i\s+will|i'?m\s+going\s+to|let\s+me)\b", re.I)
_DEFER_DELIVERY_VERB_RE = re.compile(
    r"\b(?:put|present|lay\s+out|show|share|send|give|hand|deliver|walk\s+you\s+through|"
    r"write\s+up|outline|sketch|circulate|ask|confirm|check\s+with|run\s+by|get\s+your)\b",
    re.I,
)
_DEFER_DELIVERABLE_NOUN_RE = re.compile(
    r"\b(?:plan|report|summary|analysis|options|breakdown|write-?up|proposal|"
    r"recommendations?|findings|design|spec|route|choices?|comparison|draft|"
    r"assessment|walkthrough|rundown)\b",
    re.I,
)


# ── EI-19412167276099357 defect 3: strip content a turn is QUOTING (a fenced
# code block, an inline-code span, a blockquoted peer message, a markdown
# table row) before the heuristics below scan it. Without this, a turn that
# CITES an example of the banned pattern — this very file's own evidence
# tables, a quoted fixture — gets scanned as if it were the agent's own prose
# and bounced for the citation, which is exactly backwards: that turn had
# already delivered its content in full. A fenced block is removed whole;
# blockquote and table-row LINES are dropped entirely (they carry someone
# else's / a fixture's words, never the agent's own closing sentence). ────────

_FENCED_BLOCK_RE = re.compile(r'```.*?```', re.DOTALL)
_INLINE_CODE_RE = re.compile(r'`[^`\n]+`')
_TABLE_ROW_RE = re.compile(r'^\s*\|.*\|\s*$')
_BLOCKQUOTE_LINE_RE = re.compile(r'^\s*>')
# CommonMark treats 4-space indentation as a code block same as ``` fences —
# and it's the format this very bug's own evidence used ("    (no bounce)  …").
_INDENTED_CODE_LINE_RE = re.compile(r'^ {4,}\S')


def strip_quoted_for_scanning(text):
    if not text:
        return text
    t = _FENCED_BLOCK_RE.sub(' ', text)
    t = _INLINE_CODE_RE.sub(' ', t)
    kept = []
    for ln in t.split('\n'):
        if (_TABLE_ROW_RE.match(ln) or _BLOCKQUOTE_LINE_RE.match(ln)
                or _INDENTED_CODE_LINE_RE.match(ln)):
            continue
        kept.append(ln)
    return '\n'.join(kept)


def deferred_deliverable_ending(text):
    t = (text or '').strip()
    if not t:
        return False
    # Sentence-level so the three signals must actually co-occur in one clause,
    # not merely somewhere in a long report.
    for sentence in re.split(r'(?<=[.!?])\s+|\n+', t):
        s = sentence.strip()
        if not s or len(s) > 400 or s.startswith('```'):
            continue
        if not _DEFER_FUTURE_TURN_RE.search(s):
            continue
        if not _DEFER_FIRST_PERSON_RE.search(s):
            continue
        if _DEFER_DELIVERY_VERB_RE.search(s) or _DEFER_DELIVERABLE_NOUN_RE.search(s):
            return True
    return False


DEFERRED_DELIVERABLE_REASON = (
    "This turn ends by DEFERRING something to a future turn (\"next turn I'll …\") instead of "
    "delivering it now. If you already have content — a plan, a report, an analysis, a set of "
    "options — withholding it costs the owner a full round trip for something that existed. If "
    "what you deferred is a QUESTION, asking it later costs that same round trip for no reason.\n\n"
    "The delivery-discipline rule splits the DIALOG from the content; it NEVER licenses "
    "withholding content OR a question you could ask now. Anticipating that you will need to ask "
    "something is a reason to send the content THIS turn and ask on the SAME turn's own dialog — "
    "not to send neither. Do this now:\n"
    "  1. If you have a deliverable (plan/report/analysis), write it out in THIS turn, as plain text.\n"
    "  2. If you have a question, ask it NOW — the native AskUserQuestion tool or coord:escalate —\n"
    "     do not promise to ask it later.\n"
    "  3. End the turn.\n\n"
    "If the content genuinely does not exist yet, do NOT promise it for a later turn: say "
    "plainly what is still unknown and what you are doing to resolve it, then end."
)


# ── 2026-08-08 (owner-reported: "no matter what I add to the prompts, agents keep
# saying things like 'I'll ask how you want to proceed next turn'") — the HAND-BACK
# bounce.
#
# The deferral detector above matches a WORDING — it requires the literal words "next
# turn"/"next message"/"next reply"/"next response" — because it was built from the one
# phrasing quoted in the original bug report. Measured 2026-08-08 against 18 real
# check-in endings, it caught 5 (27%): every phrasing expressing the SAME move without
# those literal words walked straight through ("let me know how you'd like to proceed",
# "standing by for your go-ahead", "awaiting your decision on the route", "your call on
# which option"). Matching the wording of one example is not matching the behavior.
#
# This detector matches the BEHAVIOR: a turn that hands the next move back to the owner
# while asking nothing ANSWERABLE — so no dialog exists to answer, and the work stops
# until the owner notices and prods it.
#
# Two independent signals, BOTH required, and only in the TAIL (last 3 non-blank lines).
# That pairing is what keeps a legitimate sign-off safe: "Done. Let me know if you hit
# any issues" carries the hand-back phrase but names no blocked decision, so it does not
# bounce. Measured on the fixture pair in the sibling test: 14/14 recall, 0/12 false
# positives. Keep those fixtures in sync with any regex change here.
_HANDBACK_MOVE_RE = re.compile(
    r"\b(?:let me know|tell me (?:which|how|what)|your call|up to you|"
    r"whichever you (?:prefer|want)|if you(?:'d| would) (?:prefer|rather|like)|want me to|"
    r"would you like|shall i|should i|do you want me to|(?:i'?ll|i will|let me) (?:ask|wait for|"
    r"hold (?:off|here)|pause|check with you|confirm with you|run (?:it|this) by you|get your)|"
    r"before i proceed|pending your|awaiting your|await your|once you (?:confirm|decide|choose|weigh in)|"
    r"on your go-ahead|say the word|standing by|over to you|ready when you are|"
    r"yours to (?:pick|choose|call))\b",
    re.I,
)
_HANDBACK_DECISION_RE = re.compile(
    r"\b(?:proceed|approach|route|option|direction|next step|go[- ]ahead|"
    r"which (?:one|way|route|option)|prefer|decide|decision|weigh in|sign[- ]off|"
    r"implement|start|begin|continue|kick off)\b",
    re.I,
)


def handback_ending(text, tail_lines=3):
    lines = [ln for ln in (text or '').rstrip().splitlines() if ln.strip()]
    if not lines:
        return False
    tail = '\n'.join(lines[-tail_lines:])
    if len(tail) > 700:
        tail = tail[-700:]
    return bool(_HANDBACK_MOVE_RE.search(tail) and _HANDBACK_DECISION_RE.search(tail))


HANDBACK_REASON = (
    "This turn ends by handing the next move back to the owner WITHOUT asking anything "
    "answerable — a hand-back, not a question. Nothing can happen now: there is no dialog "
    "to answer, so the work stops until the owner notices and prods you. That is a silent "
    "halt in a politeness costume, and it is the most-reported agent failure here.\n\n"
    "Ending a turn is safe ONLY when a re-wake is GUARANTEED — an armed engine loop you have "
    "VERIFIED active this session, a registered events:await that will fire, or an owner who "
    "will demonstrably speak next. A closing line like \"let me know how you'd like to "
    "proceed\" is not a wake source. Do ONE of these now:\n"
    "  1. Need an owner decision? ASK IT THIS TURN via the native AskUserQuestion tool — a "
    "real dialog, self-contained options. Never merely announce that you will ask.\n"
    "  2. Can you decide it yourself? DECIDE, act, and disclose the call you made. Under AUTO "
    "mode this is mandatory: choosing the next step IS the job.\n"
    "  3. Blocked on something else? Park on it (events:await) or arm a loop (loop:arm), and "
    "say which — an explicit wake source, never a hand-back.\n"
    "  4. Genuinely finished? Say so plainly, with no request for direction attached."
)


# A Stop payload can contain the final assistant text directly, but the payload does
# not say which tool calls an earlier assistant frame in the SAME model turn made.
# The transcript is the source for that distinction. Resolve only narrow imminent
# claims to a concrete tool so an unrelated call cannot satisfy the assertion.
_IMMEDIATE_RE = re.compile(r"\b(?:now|immediately|right\s+now|this\s+turn)\b", re.I)
_FIRST_PERSON_RE = r"(?:i(?:'m| am|'ll| will)|we(?:'re| are|'ll| will))"
_ACTION_BOUNDARY = r"(?=$|[\s,.;:!?—-])"
_COMPACTION_ACTION_RE = r"(?:compact(?:ing)?|request(?:ing)?\s+compaction|go(?:ing)?\s+(?:quiet|silent))"
_LOOP_ACTION_RE = r"(?:arm(?:ing)?|start(?:ing)?|set(?:ting)\s+up)\s+(?:an?\s+)?loop"
_TOOL_NAME_TOKEN = r"(?:[A-Za-z][A-Za-z0-9_-]*:[A-Za-z][A-Za-z0-9_-]*(?:[:][A-Za-z0-9_-]+)*|mcp__[A-Za-z0-9_]+(?:__[A-Za-z0-9_]+)+)"
_TOOL_CALL_VERB_RE = r"(?:call(?:ing)?|invoke(?:ing)?|run(?:ning)?|fire(?:ing)?|trigger(?:ing)?|execute(?:ing)?)"


def _imminent_action_claim(line, action_re, tool):
    """Resolve one action phrase when it is first-person and imminent."""
    candidate = line.strip()
    action = (
        r"(?:^\s*(?:now\s+)?" + action_re + _ACTION_BOUNDARY + r")"
        r"|(?:\b" + _FIRST_PERSON_RE + r"\s+(?:(?:now|right\s+now)\s+)?"
        + action_re + _ACTION_BOUNDARY + r")"
        r"|(?:\b" + _FIRST_PERSON_RE + r"\s+going\s+to\s+" + action_re + _ACTION_BOUNDARY + r")"
    )
    match = re.search(action, candidate, re.I)
    if not match:
        return None
    # The bare form must carry its own immediacy ("Compacting now"); the
    # first-person forms may place "now" after the action.
    if not _IMMEDIATE_RE.search(candidate[match.start():]):
        return None
    return {'tool': tool, 'label': candidate[:240]}


def _named_tool_claim(line):
    """Resolve a first-person or bare imperative claim naming a tool."""
    candidate = line.strip()
    pattern = (
        r"(?:^\s*|\b" + _FIRST_PERSON_RE + r"\s+(?:(?:now|right\s+now)\s+)?)"
        + _TOOL_CALL_VERB_RE
        + r"\s+(?:the\s+)?[\"']?(?P<tool>" + _TOOL_NAME_TOKEN + r")"
    )
    match = re.search(pattern, candidate, re.I)
    if not match or not _IMMEDIATE_RE.search(candidate[match.end():]):
        return None
    return {'tool': match.group('tool'), 'label': candidate[:240]}


def claimed_action_ending(text, tail_lines=3):
    """Resolve one narrow imminent first-person claim in the turn's tail."""
    lines = [ln.replace('’', "'") for ln in (text or '').rstrip().splitlines() if ln.strip()]
    for line in lines[-tail_lines:]:
        candidate = line.strip()
        if not candidate or len(candidate) > 300:
            continue
        for action_re, tool in (
            (_COMPACTION_ACTION_RE, 'session:request-compaction'),
            (_LOOP_ACTION_RE, 'loop:arm'),
        ):
            claim = _imminent_action_claim(candidate, action_re, tool)
            if claim:
                return claim
        claim = _named_tool_claim(candidate)
        if claim:
            return claim
    return None


def _tool_name_key(name):
    return re.sub(r'[^a-z0-9]', '', str(name or '').lower())


def tool_names_match(expected, actual):
    """Match colon/dash/underscore spellings and MCP-prefixed tool names."""
    expected_key = _tool_name_key(expected)
    actual_key = _tool_name_key(actual)
    return bool(expected_key and actual_key and (
        expected_key == actual_key
        or expected_key.endswith(actual_key)
        or actual_key.endswith(expected_key)
    ))


def claimed_action_reason(claim):
    return (
        "This turn ends by CLAIMING that an imminent action is happening "
        f"({claim['label']}) without a matching {claim['tool']} tool call in this turn. "
        "A sentence asserting an action does not execute that action, and ending here "
        "can silently halt the session. Perform the action now through its real tool, "
        "or state the blocker and continue with a verified wake source; do not announce "
        "that you did something you did not do."
    )


_TOOL_CALL_BLOCK_TYPES = frozenset(('tool_use', 'tool_call', 'function_call'))
_TOOL_RESULT_BLOCK_TYPES = frozenset(('tool_result', 'tool_return', 'tool_response', 'function_result'))


def _message_content(obj):
    msg = obj.get('message') if isinstance(obj, dict) else None
    if not isinstance(msg, dict):
        return None
    return msg.get('content')


def _content_blocks(obj):
    content = _message_content(obj)
    return content if isinstance(content, list) else []


def _contains_tool_call(obj):
    if not isinstance(obj, dict):
        return False
    if obj.get('type') in _TOOL_CALL_BLOCK_TYPES:
        return True
    return any(
        isinstance(block, dict) and block.get('type') in _TOOL_CALL_BLOCK_TYPES
        for block in _content_blocks(obj)
    )


def _is_dispatcher_tool_name(name):
    """True for tools:invoke and its MCP-prefixed spellings.

    A dispatcher does not DO anything itself: it forwards to another tool whose
    real name travels in its arguments, so the outer block name is never the
    tool that actually ran.
    """
    return _tool_name_key(name).endswith('toolsinvoke')


def _dispatched_tool_name(block):
    """EI-23745075736001151 — recover the tool a dispatcher actually ran.

    A colon-form tool sent through tools:invoke appears in the transcript as
    `mcp__<server>__tools_invoke`, with the tool that REALLY ran named only in
    that block's arguments. Reading the outer name alone reports a genuine
    session:request-compaction (or any other gated call) as never made, so the
    Stop gate refuses to let the turn end -- a livelock on precisely the door
    the su playbook mandates when a colon-form name will not resolve directly,
    and one that fires hardest on a session already over its context limit.
    """
    for key in ('input', 'tool_input', 'toolInput', 'arguments', 'args', 'parameters'):
        args = block.get(key)
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                continue
        if not isinstance(args, dict):
            continue
        inner = args.get('name') or args.get('tool') or args.get('tool_name')
        if isinstance(inner, str) and inner.strip():
            return inner.strip()
    return None


def _tool_call_names(obj):
    if not isinstance(obj, dict):
        return []
    blocks = []
    if obj.get('type') in _TOOL_CALL_BLOCK_TYPES:
        blocks.append(obj)
    blocks.extend(
        block for block in _content_blocks(obj)
        if isinstance(block, dict) and block.get('type') in _TOOL_CALL_BLOCK_TYPES
    )
    names = []
    for block in blocks:
        name = block.get('name') or block.get('tool_name') or block.get('toolName')
        if isinstance(name, str) and name.strip():
            name = name.strip()
            names.append(name)
            # Keep the outer dispatcher name too: it is what a claim naming
            # tools:invoke itself would match against.
            if _is_dispatcher_tool_name(name):
                dispatched = _dispatched_tool_name(block)
                if dispatched:
                    names.append(dispatched)
    # A nameless tool-use block still proves that a call occurred, but cannot
    # satisfy a claim that names a different concrete tool.
    return names


def _is_tool_result_only_user(obj):
    if not isinstance(obj, dict) or obj.get('type') != 'user':
        return False
    blocks = _content_blocks(obj)
    return bool(blocks) and all(
        isinstance(block, dict) and block.get('type') in _TOOL_RESULT_BLOCK_TYPES
        for block in blocks
    )


def _assistant_text_from_message(obj):
    if not isinstance(obj, dict) or obj.get('type') != 'assistant':
        return ''
    content = _message_content(obj)
    if isinstance(content, str):
        return content
    texts = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str):
                texts.append(block['text'])
    return '\n'.join(texts)


def last_assistant_turn(transcript_path):
    """Return final assistant text plus current-turn tool-call evidence.

    Result keys are text, tool_call_seen (bool or None), and known. known is
    false when the transcript cannot be read or has no assistant text; callers
    must fail open in that case. The last non-tool-result user frame marks the
    beginning of the current model turn.
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return {'text': '', 'tool_call_seen': None, 'known': False}
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, 'rb') as f:
            if size > TRANSCRIPT_TAIL_BYTES:
                f.seek(size - TRANSCRIPT_TAIL_BYTES)
            raw_bytes = f.read()
    except Exception:
        return {'text': '', 'tool_call_seen': None, 'known': False}
    text = raw_bytes.decode('utf-8', 'replace')
    lines = text.split('\n')
    if size > TRANSCRIPT_TAIL_BYTES:
        lines = lines[1:]  # drop a possibly-torn first line from the seek
    entries = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            entries.append(obj)

    current_start = 0
    for index in range(len(entries) - 1, -1, -1):
        if entries[index].get('type') == 'user' and not _is_tool_result_only_user(entries[index]):
            current_start = index + 1
            break

    current_entries = entries[current_start:]
    tool_call_names = [
        name for entry in current_entries for name in _tool_call_names(entry)
    ]
    tool_call_seen = any(_contains_tool_call(entry) for entry in current_entries)
    for entry in reversed(current_entries):
        candidate = _assistant_text_from_message(entry)
        if candidate:
            return {
                'text': candidate,
                'tool_call_seen': tool_call_seen,
                'tool_call_names': tool_call_names,
                'known': True,
            }
    return {'text': '', 'tool_call_seen': None, 'known': False}


def explicit_assistant_text(value):
    """Read Claude's documented last_assistant_message Stop field when present."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if isinstance(value.get('text'), str):
            return value['text']
        content = value.get('content')
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            texts = [
                block.get('text') for block in content
                if isinstance(block, dict) and isinstance(block.get('text'), str)
            ]
            return '\n'.join(texts)
    return ''


def last_assistant_text(transcript_path):
    """Compatibility wrapper returning only the final assistant text."""
    return last_assistant_turn(transcript_path)['text']


# ── PreToolUse: open the blocked-session gate before the dialog renders ────────
if name == 'PreToolUse':
    if tool_name not in GATE_TOOLS:
        sys.exit(0)
    question, options, text = build_ask_question(tool_name, tool_input)
    if not question:
        sys.exit(0)
    args = {
        'sessionId': session_id or (owner + ':' + tool_name),
        'client': 'claude',
        'kind': 'ask',
        'refId': tool_use_id or (session_id + ':' + tool_name),
        'question': question,
        'ownerId': owner,
    }
    if options:
        args['options'] = options
    if text:
        args['text'] = text
    if harness:
        args['harness'] = harness
    call_tool('sessions:ingest-gate-event', args)
    sys.exit(0)

# ── PostToolUse: the dialog resolved (a tool_result exists) — auto-resolve ──────
if name == 'PostToolUse':
    if tool_name not in GATE_TOOLS:
        sys.exit(0)
    call_tool('sessions:ingest-gate-event', {
        'sessionId': session_id or (owner + ':' + tool_name),
        'client': 'claude',
        'kind': 'cleared',
        'refId': tool_use_id or (session_id + ':' + tool_name),
    })
    sys.exit(0)

# ── Notification: capture a permission-wait (the one shape a watcher can't
# see any faster than the client telling us directly). ─────────────────────────
if name == 'Notification':
    message = report_str(first('message'))
    if not message or 'permission' not in message.lower():
        sys.exit(0)
    args = {
        'sessionId': session_id or owner,
        'client': 'claude',
        'kind': 'permission_wait',
        'refId': 'notify:' + (session_id or owner),
        'text': message[:4000],
        'ownerId': owner,
    }
    if harness:
        args['harness'] = harness
    call_tool('sessions:ingest-gate-event', args)
    sys.exit(0)

# ── Stop: ask-mirror + bounce ───────────────────────────────────────────────────
if name != 'Stop':
    sys.exit(0)

# Loop guard FIRST — Claude sets this true on the hook-triggered continuation
# that follows our own `decision:block`. Never bounce twice in one turn.
if truthy(first('stop_hook_active', 'stopHookActive')):
    sys.exit(0)

# Best-effort: a turn ending means any mid-turn permission wait is moot.
call_tool('sessions:ingest-gate-event', {
    'sessionId': session_id or owner,
    'client': 'claude',
    'kind': 'cleared',
    'refId': 'notify:' + (session_id or owner),
}, timeout=2, retries=1, label='stop-notify-clear')

transcript_path = first('transcript_path', 'transcriptPath') or ''
turn = last_assistant_turn(transcript_path)
final_text = explicit_assistant_text(first('last_assistant_message', 'lastAssistantMessage')) or turn['text']
# EI-19412167276099357 defect 3: scan a QUOTE-STRIPPED copy so citing the
# banned pattern (a fixture, a table row, someone else's message) can never
# itself trip the bounce. `final_text` (unstripped) is kept for the <ask> tag
# parse below — that is a deliberate structured block, never a quoted example.
scan_text = strip_quoted_for_scanning(final_text)

# WI-5865: computed BEFORE the ask-mirror so a turn that both mirrors an ask AND
# defers its content still gets bounced — the mirror fires first (the owner's
# question is never dropped), then we fall through to the deferral bounce.
deferred = deferred_deliverable_ending(scan_text)

ask = parse_ask_tag(final_text)
if ask:
    escalate_args = {
        'severity': 'question',
        'summary': ask['question'][:2000],
    }
    if ask.get('options'):
        escalate_args['options'] = [{'id': o['id'][:64], 'label': o['label'][:200]} for o in ask['options']]
    if ask.get('refs'):
        escalate_args['body'] = 'refs: ' + ', '.join(ask['refs'])
    # EI-14208: this is the one silent-drop that matters most — an owner-directed
    # <ask> that never reaches the Inbox — so retry once before giving up + logging.
    call_tool('coord:escalate', escalate_args, timeout=5, retries=1, label='stop-ask-escalate')
    if not deferred:
        sys.exit(0)  # structured mirror landed — allow the stop.

if deferred:
    # WI-5865 — the deferral bounce. Ranked ABOVE the question-shaped bounce
    # because withheld content is the costlier failure: a question at least
    # reaches the owner, whereas a deferred plan reaches nobody and burns a
    # round trip. The reason text teaches the fix rather than just refusing.
    print(json.dumps({'decision': 'block', 'reason': DEFERRED_DELIVERABLE_REASON}))
    sys.exit(0)

if question_shaped_ending(scan_text):
    # inbox-pane-active-scope-dates-filters-2026-07-19 P-401 (D-2/b): steer the
    # re-emit to the NATIVE AskUserQuestion tool, NOT a raw `<ask>` text tag. The
    # tag is a GUI wire-format that a TERMINAL (TUI) session renders as literal,
    # unreadable XML — the owner explicitly flagged that (2026-07-19). The native
    # tool renders a proper interactive dialog in the terminal AND is already
    # mirrored into the owner's Inbox by this hook's own PreToolUse branch, so it
    # keeps the durability the convention wants without the raw-XML regression.
    reason = (
        "This turn ended with what reads as a question to the owner, but with no "
        "structured mirror. Per papercusp convention (owner-inbox-single-pane-2026-07-17 "
        "D-001 / D-004), an owner-directed question must ride a durable, renderable "
        "channel — re-emit it through ONE of:\n"
        "  • the native AskUserQuestion tool (preferred: renders a real interactive "
        "dialog in the terminal AND registers in the owner's Inbox), or\n"
        "  • coord:escalate (a durable card, answerable from the Inbox).\n"
        "Do NOT emit a raw <ask>{...}</ask> text block — it renders as unreadable XML "
        "in a terminal session. Re-emit through one of the above, then stop."
    )
    print(json.dumps({'decision': 'block', 'reason': reason}))
    sys.exit(0)

claim = claimed_action_ending(scan_text)
if (turn['known'] and claim
        and not any(tool_names_match(claim['tool'], actual) for actual in turn.get('tool_call_names', []))):
    print(json.dumps({'decision': 'block', 'reason': claimed_action_reason(claim)}))
    sys.exit(0)

if handback_ending(scan_text):
    # 2026-08-08: ranked LAST — the branches above catch endings that at least ASK
    # something (a deferred deliverable; a literal question needing a durable channel).
    # This catches the residue neither was built to see: an ending that asks nothing at
    # all and simply stops, waiting to be prodded.
    print(json.dumps({'decision': 'block', 'reason': HANDBACK_REASON}))
    sys.exit(0)

sys.exit(0)  # a normal, non-question ending — nothing to mirror.
PYEOF

# EI-14208: close the outer fail-open's own blind spot — if the python body
# itself crashed/exited non-zero for some reason other than its own normal
# `sys.exit(0)` branches (e.g. before it could reach a log_failure call), log
# that here so a totally-broken hook run is still inspectable, not silently
# indistinguishable from "nothing to do this turn".
if [ "$PY_STATUS" -ne 0 ]; then
  LOG_DIR="${HOME}/.papercusp/hooks/cc"
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  printf '%s session=%s hook-body-nonzero-exit status=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PAPERCUSP_SID:-?}" "$PY_STATUS" \
    >> "$LOG_DIR/ask-gate-mirror.errors.log" 2>/dev/null || true
fi
exit 0
