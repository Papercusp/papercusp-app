# pc_nested_cli.sh — the CACHED nested-CLI verdict for per-TOOL-CALL hooks (WI-10004945).
#
# pc_nested_cli.py answers "is the agent CLI running this hook NESTED inside another
# agent?" (WI-10003957): a `claude`/`codex` run from an su's Bash tool or under a
# capability:bash job inherits that su's PAPERCUSP_SID, so every global hook it fires
# acts AS the su. The python costs an interpreter start + a /proc walk (~30ms). That is
# fine once per turn (lifecycle, UserPromptSubmit, Stop), but not on EVERY tool call
# fleet-wide. This is the per-call form: it finds the CLI process with bash builtins
# only (no fork) and reads the verdict the python already wrote for that exact process.
# Only a cache MISS, once per CLI process, starts python.
#
# CACHE KEY: the first ancestor of the hook whose argv[0] is NOT a shell — the CLI that
# spawned the hook (claude, codex's vendor binary, a node entrypoint) — plus its start
# time, so a recycled pid can never inherit another process's verdict. Stopping at the
# FIRST non-shell process is what keeps this correct: a nested CLI's ancestry passes
# through the outer su's CLI, whose cached verdict is "managed". Searching upward for
# any ancestor with a cache entry would hand the nested CLI the su's verdict.
#
# The verdict itself is never decided here; pc_nested_cli.py stays the one decision
# procedure. Whatever this reader cannot establish falls through to running that python
# uncached, never to a guessed verdict.
#
# Usage from a bash hook, AFTER its PAPERCUSP_SID scope guard:
#   . "$(dirname "$0")/pc_nested_cli.sh"
#   if pc_nested_cli_cached; then exit 0; fi
# Call it ONLY as an `if` condition: that is what keeps a hook's `set -e` from turning a
# failed /proc read into a hook failure. The function is also nounset-safe.
#
# Usage from a non-bash hook (exit 0 = nested), naming the hook's own parent pid:
#   PC_NESTED_CLI_START_PID=<hook's parent pid> bash pc_nested_cli.sh
#
# PC_NESTED_CLI_CACHE_DIR overrides the cache directory (tests). The default lives in
# the per-user runtime dir (mode 0700, tmpfs, emptied at logout).

PC_NESTED_CLI_DIR="${BASH_SOURCE[0]%/*}"

_pc_nested_cli_is_shell() {
  local a0="${1##*/}"
  a0="${a0#-}"  # a login shell's argv[0] is "-bash"
  case "$a0" in
    sh|bash|dash|zsh|ksh|mksh|ash|busybox) return 0 ;;
  esac
  return 1
}

pc_nested_cli_cached() {
  local pid="${PC_NESTED_CLI_START_PID:-$PPID}" hops=0 stat="" a0="" key="" verdict=""
  local cache_dir="${PC_NESTED_CLI_CACHE_DIR:-${XDG_RUNTIME_DIR:-${HOME}/.papercusp/run}/papercusp-nested-cli}"
  local -a fields=()
  while [ "$hops" -lt 16 ]; do
    hops=$((hops + 1))
    case "$pid" in '' | *[!0-9]*) break ;; esac
    [ "$pid" -gt 1 ] || break
    stat=""
    { IFS= read -r stat <"/proc/$pid/stat"; } 2>/dev/null || true
    [ -n "$stat" ] || break
    a0=""
    # argv[0] is the first NUL-terminated field; read returns non-zero at EOF.
    { IFS= read -r -d '' a0 <"/proc/$pid/cmdline"; } 2>/dev/null || true
    # "pid (comm) state ppid …" — comm may hold spaces or parens, so cut at the LAST ") ".
    IFS=' ' read -r -a fields <<<"${stat##*) }" || true
    if [ -n "$a0" ] && ! _pc_nested_cli_is_shell "$a0"; then
      [ -n "${fields[19]:-}" ] && key="$pid-${fields[19]}"
      break
    fi
    pid="${fields[1]:-}"
  done

  if [ -n "$key" ]; then
    { IFS= read -r verdict <"$cache_dir/$key"; } 2>/dev/null || true
    case "$verdict" in
      nested*) return 0 ;;
      managed) return 1 ;;
    esac
    python3 "$PC_NESTED_CLI_DIR/pc_nested_cli.py" --cache "$cache_dir/$key" >/dev/null 2>&1
    return
  fi
  python3 "$PC_NESTED_CLI_DIR/pc_nested_cli.py" >/dev/null 2>&1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  pc_nested_cli_cached
  exit $?
fi
