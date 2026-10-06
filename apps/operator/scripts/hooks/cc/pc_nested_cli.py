"""Is the agent CLI running this hook NESTED inside another agent? (WI-10003957)

PAPERCUSP_SID is inherited by every descendant of an su: a CLI run from its
native Bash tool, and anything under a capability:bash job (that job env exports
PAPERCUSP_SID too). Such a nested `claude`/`codex` fires the SAME global hooks,
so without this check its SessionStart/SessionEnd are reported AS the su.
Measured 2026-09-29: a test's `claude -p 'say ok'` probe inside su-075445e6's
capability:bash integration run ended, the operator read it as the su's
terminal end, and lifecycle-report.sh fleet:kill'ed the live session.

Only POSITIVE evidence counts; when /proc cannot answer, the verdict is None
("not nested") and the hook behaves exactly as before:
  - the CLI's parent is psu-pty-host  → the managed incarnation, never nested;
  - another agent CLI sits above it (separated by a non-CLI process, e.g. the
    Bash tool's shell or a vitest worker) → nested;
  - a capability:bash job marker is in the environment → nested.

Hook processes run as descendants of their CLI, so the walk starts at the
hook's parent. A contiguous chain of agent-CLI processes (Codex's node wrapper
over its vendor-native binary) counts as ONE CLI.

Per-turn hooks run this directly. Hooks that fire on EVERY tool call read a
verdict cached per CLI process instead (pc_nested_cli.sh, WI-10004945); on a
miss that reader runs this file with `--cache <path>` to record the verdict.
"""
import os

AGENT_CLI_NAMES = ('claude', 'codex')
CAPABILITY_BASH_MARKERS = (
    'PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID',
    'PAPERCUSP_CAPABILITY_BASH_FOREGROUND',
)
MAX_HOPS = 64


def read_proc(pid):
    """(ppid, argv) for pid, or None when /proc cannot answer."""
    try:
        with open('/proc/%d/cmdline' % pid, 'rb') as f:
            argv = [a.decode('utf-8', 'replace') for a in f.read().split(b'\0') if a]
        with open('/proc/%d/stat' % pid, 'rb') as f:
            stat = f.read().decode('utf-8', 'replace')
        # "pid (comm) state ppid ..." — comm may contain spaces or parens.
        ppid = int(stat[stat.rindex(')') + 2:].split()[1])
        return ppid, argv
    except (OSError, ValueError, IndexError):
        return None


def is_agent_cli(argv):
    if not argv:
        return False
    base = os.path.basename(argv[0])
    if base in AGENT_CLI_NAMES or base.startswith('codex-'):
        return True
    if base.startswith('node') and len(argv) > 1:
        script = argv[1]
        return '@anthropic-ai/claude-code' in script or os.path.basename(script) in AGENT_CLI_NAMES
    return False


# psu-launcher.mjs hosts the PTY IN-PROCESS (it imports psu-pty-host.mjs), so on a
# live box the managed CLI's parent is usually the launcher, not a separate
# psu-pty-host process (measured 2026-09-29: every su/grader claude was a direct
# child of `node …/psu-launcher.mjs`). Either parent means psu minted this CLI's
# PAPERCUSP_SID for it — it did not inherit one — so it is never nested, even when
# the launcher itself was started from inside another agent's tool.
PSU_HOST_SCRIPTS = ('psu-pty-host.mjs', 'psu-launcher.mjs')


def is_psu_host(argv):
    return any(os.path.basename(a) in PSU_HOST_SCRIPTS for a in (argv or [])[:4])


def nested_cli_reason(start_pid=None, environ=None, proc=read_proc):
    """A short reason when the hook's CLI is provably nested, else None."""
    environ = os.environ if environ is None else environ
    pid = os.getppid() if start_pid is None else start_pid

    # 1) The CLI running this hook: the nearest agent-CLI ancestor.
    cli = None
    for _ in range(MAX_HOPS):
        if not pid or pid <= 1:
            return None
        info = proc(pid)
        if info is None:
            return None
        if is_agent_cli(info[1]):
            cli = (pid, info[0])
            break
        pid = info[0]
    if cli is None:
        return None

    # Collapse a contiguous agent-CLI chain into one CLI unit.
    parent = cli[1]
    for _ in range(MAX_HOPS):
        info = proc(parent) if parent and parent > 1 else None
        if info is None or not is_agent_cli(info[1]):
            break
        parent = info[0]

    parent_info = proc(parent) if parent and parent > 1 else None
    if parent_info is not None and is_psu_host(parent_info[1]):
        return None  # the managed incarnation, direct child of its psu host

    # 2) Another agent CLI further up → running inside that agent's tools.
    pid = parent
    for _ in range(MAX_HOPS):
        if not pid or pid <= 1:
            break
        info = proc(pid)
        if info is None:
            break
        if is_agent_cli(info[1]):
            return 'nested under agent CLI pid %d' % pid
        pid = info[0]

    # 3) A capability:bash job descendant (its tree does not run under the CLI).
    for key in CAPABILITY_BASH_MARKERS:
        if key in environ:
            return 'inside a capability:bash job (%s)' % key
    return None


def proc_starttime(pid):
    """Field 22 of /proc/<pid>/stat (start time in clock ticks), or None."""
    try:
        with open('/proc/%d/stat' % pid, 'rb') as f:
            stat = f.read().decode('utf-8', 'replace')
        return stat[stat.rindex(')') + 2:].split()[19]
    except (OSError, ValueError, IndexError):
        return None


MAX_CACHE_ENTRIES = 512


def write_cache(path, reason):
    """Persist this verdict for pc_nested_cli.sh (WI-10004945). The file name is
    `<pid>-<starttime>` of the CLI process the bash reader keyed on; its first word
    is `nested` or `managed`. Best-effort: any failure only costs a re-check.

    Also prunes siblings whose process is gone (pid exited, or reused with a
    different start time). That runs only here — on a cache MISS, once per CLI —
    so the per-tool-call hit path never pays for it."""
    try:
        directory = os.path.dirname(path)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        tmp = '%s.tmp.%d' % (path, os.getpid())
        with open(tmp, 'w') as f:
            f.write(('nested ' + reason) if reason else 'managed')
            f.write('\n')
        os.replace(tmp, path)
        for name in sorted(os.listdir(directory))[:MAX_CACHE_ENTRIES]:
            pid, _, start = name.partition('-')
            if not pid.isdigit() or '.tmp.' in name:
                continue
            if proc_starttime(int(pid)) != start:
                try:
                    os.unlink(os.path.join(directory, name))
                except OSError:
                    pass
    except OSError:
        pass


if __name__ == '__main__':
    import sys
    reason = nested_cli_reason()
    # `--cache <dir>/<pid>-<starttime>`: pc_nested_cli.sh's cache miss. Record the
    # verdict so later tool calls of the same CLI skip this python + /proc walk.
    if len(sys.argv) == 3 and sys.argv[1] == '--cache':
        write_cache(sys.argv[2], reason)
    if reason:
        sys.stdout.write(reason + '\n')
        sys.exit(0)
    sys.exit(1)
