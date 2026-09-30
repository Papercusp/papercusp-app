# A path-matching pkill/ps cleanup suicides its own caller when the path is an argv
URL: /internal/docs/agent-insights/pkill-on-argv-path-suicides-the-caller

A cleanup that kills processes whose cmdline contains a $WORK path (pkill -f "$work" or ps|grep -F "$work") will match — and SIGKILL — the cleanup script itself AND its invoking shell when $WORK arrives as a command-line argument, because the path is then in their argv. In-process traps dodge this (the path is a runtime var); standalone "clean up <DIR>" tools do not. Protect self + ancestors.

## What

A very common cleanup idiom kills every process whose command line references a
per-run sandbox path:

```bash
pkill -9 -f "$work"
# or
ps -eo pid,args | grep -F "$work" | grep -v grep | awk '{print $1}' | xargs -r kill -9
```

This is correct **inside a rig's EXIT trap**, where `$work` is a runtime `mktemp`
variable that appears in the spawned instances' argv but NOT in the rig process's
own argv. It becomes a **self-suicide** the moment you factor the same cleanup into
a STANDALONE tool invoked as `cleanup-run.sh <WORK>`:

* The cleanup script's own argv is now `bash cleanup-run.sh /tmp/<rig>.XXXX` →
  `pkill -f "$work"` matches it → the cleanup is SIGKILLed mid-run (often before the
  `rm`).
* Worse, the **invoking shell** (an agent's interactive shell, or a test harness
  whose inline script text contains the path) is *also* matched and killed — so the
  agent loses their whole session, not just the cleanup.

Observed live 2026-06-20 (EI-1739) while adding `cleanup-run.sh`/`reap-orphans.sh`
to the two-instance rigs: the first run killed the test harness itself, then the
reaper false-flagged dead dirs as "live" because a transient command-substitution
subshell (forked from a shell whose argv held the path) matched the `pgrep`.

## Fix: exclude self + ancestors

Compute the current process + its whole ancestor chain and skip them in every
kill / liveness check:

```bash
fed_self_and_ancestors() {            # echo " PID PID … "
  local cur=$$ out=" $$ "
  while :; do
    cur=$(awk '/^PPid:/{print $2}' "/proc/$cur/status" 2>/dev/null)   # robust to comm spaces/parens
    { [ -n "$cur" ] && [ "$cur" -gt 1 ] 2>/dev/null; } || break
    out+="$cur "
  done
  printf '%s' "$out"
}

protect="$(fed_self_and_ancestors)"
ps -eo pid,args | grep -F "$work" | grep -v grep | awk '{print $1}' | while read -r pid; do
  case "$protect" in *" $pid "*) continue;; esac
  kill -9 "$pid" 2>/dev/null || true
done
```

* `$$` stays the **main shell** pid even inside `$(…)` (bash special-cases it), so
  `protect="$(fed_self_and_ancestors)"` captures the right tree.
* Parse PPid from `/proc/$pid/status` (`PPid:` line), NOT `awk '{print $4}'` on
  `/proc/$pid/stat` — a `comm` with spaces/parens breaks field-4 splitting.
* Apply the same exclusion to a `pgrep -f "$dir"` liveness probe (a reaper that
  decides "is this run still alive?"), or your own process tree reads as a live user
  of the dir and you never reap a genuinely dead run.

## Testing gotcha (don't get fooled like I did)

Verify these tools by running the test **from a file** (`bash verify.sh`), never
inline. An inline `bash -c '…/tmp/<rig>.X…'` puts the rig paths in the harness's
own argv, so `pkill`/`pgrep` match the harness and forked command-substitution
subshells — producing false "live" / self-kills that are artifacts of the test, not
the code. A real `*.sh` process has argv `bash script.sh` (the path, not the
contents), which is the production reality.

## Related

* EI-1739 — the two-instance rig cleanup collision this came from. The general
  lesson: any "kill everything matching this path" cleanup must exclude the killer's
  own process tree once the path can be an argv.
