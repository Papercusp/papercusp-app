# Triaging a canonical run: per-task test output lives in a SECOND log, not the one you redirected
URL: /internal/docs/agent-insights/affected-tests-per-task-output-lives-in-a-second-log

Why grepping a canonical `npm test` / affected-tests log for FAIL lines, assertion text or unhandled errors returns a confident zero — the orchestrator stdout you captured contains no test output by design; it is journaled to a separate runner-owned file. How to find yours, and the four traps around it.

## The symptom

You run the canonical suite, redirect it to a log, and later try to triage it:

```bash
npm test > /tmp/my-run.log 2>&1 &
# ... an hour later ...
grep -c 'Unhandled Error' /tmp/my-run.log     # 0
grep -cE '^ *Tests +[0-9]+ failed' /tmp/my-run.log  # 0
grep -c 'AssertionError' /tmp/my-run.log      # 0
```

Every grep returns zero. The natural conclusion — "this artifact cannot answer what failed; the per-task output was not retained" — is **wrong**, and it is wrong in the most expensive way: a zero from a correct regex against a real file reads exactly like a measured absence.

I concluded exactly this and reported to two peers that a clause requiring "zero unhandled errors" was NOT MEASURABLE from the run log. It was measurable. There were six.

## The cause: there are TWO logs

The file you redirected is the **orchestrator's stdout** — `AFFECTED_TASK_PROGRESS` lines, admission lines, cache writes. It genuinely contains no test output.

Child output goes somewhere else. `scripts/affected-tests.mjs` journals each settled task to a **runner-owned** log:

```
RUN_LOG_ROOT = join(tmpdir(), "papercusp-affected-tests")
RUN_TOKEN    = `${process.pid}-${randomBytes(4).toString("hex")}`
RUN_LOG_PATH = join(RUN_LOG_ROOT, `${RUN_TOKEN}.log`)
```

`journalCapturedTaskOutput()` appends each task's full stdout/stderr there, wrapped in an attributable envelope:

```
AFFECTED_TASK_OUTPUT_BEGIN task="<ws> :: <script>" ... exitStatus=<n> capturedBytes=<n>
<the child's entire stdout>
<the child's entire stderr>
AFFECTED_TASK_OUTPUT_END task="<ws> :: <script>"
```

And then `emitCapturedTaskOutput()` **deliberately does not duplicate it** into the console/log path:

```js
if (!r.__outputJournaled) {
  logLine(r.stdout ?? "");
  logLine(r.stderr ?? "");
}
```

That `if` is the whole story. The output is not missing; it was routed away from the stream you captured, on purpose — the source comment says the run log "must retain every task that already settled even if a signal kills the parent while another task is still running."

This is by design and it is a *good* design: the journal survives a killed parent, and its own comment notes it "deliberately outlives this process so a background-job notifier or later triager can read the complete verdict." It is built for exactly the triage you are doing. You just have to look in it.

## Finding YOUR log

`RUN_TOKEN` is `<pid>-<hex>`, where the pid is the **affected-tests.mjs** process — not your `npm test` pid. Walk down to it:

```bash
# find the affected-tests node that descends from your npm test pid
ps -eo pid=,ppid=,comm= | ...   # or walk /proc/<pid>/stat field 4 upward
```

Then the log is `$TMPDIR/papercusp-affected-tests/<that-pid>-<hex>.log`.

Note `TMPDIR` is not necessarily `/tmp` — a run launched through `pc-heavy.sh` may sit under `/tmp/pcv/papercusp-affected-tests/`. Locate the directory rather than assuming:

```bash
find /tmp /var/tmp -maxdepth 3 -type d -name papercusp-affected-tests
```

## Four traps, all of which produce a confident wrong answer

**1. The directory is SHARED across agents — the newest, largest, actively-growing log is often someone else's.** On a busy box several canonical runs journal into the same directory. Picking by mtime or size will hand you a peer's run, and it will look perfectly plausible: live timestamp, right shape, right size. Always verify the filename's pid prefix is a descendant of *your* run before scoring a single line of it:

```bash
cur=<log-pid>; while :; do ppid=$(awk '{print $4}' /proc/$cur/stat); \
  [ "$ppid" = "<your npm test pid>" ] && echo MINE && break; \
  [ "$ppid" = 1 ] && echo NOT-MINE && break; cur=$ppid; done
```

**2. No open file descriptor is EXPECTED, not disproof of ownership.** `journalCapturedTaskOutput` uses `appendAllSync` — open, append, close. So `ls -l /proc/<pid>/fd | grep <log>` returns nothing even while that process is actively writing it. Do not read the empty fd list as "this process isn't writing this file."

**3. ANSI escapes make raw greps return false zeros.** Strip first, always:

```bash
sed -e 's/\x1b\[[0-9;]*[a-zA-Z]//g' raw.log > stripped.txt
```

**4. Anchored patterns miss vitest's banners, which are wrapped in box-drawing characters.** The unhandled-errors banner is not `  Unhandled Errors`; it is `⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯`. So `grep -cE '^ *Unhandled Errors'` returns 0 against a file that contains it. Use an unanchored substring (`grep -c 'Unhandled Error'`) and confirm with `grep -n` before believing either a zero or a count.

## Useful extractions once you have the right file

Attribute anything to its enclosing task by tracking the envelope:

```bash
# per-task failure counts
awk '/AFFECTED_TASK_OUTPUT_BEGIN/ { match($0,/task="[^"]*"/); t=substr($0,RSTART+6,RLENGTH-7) }
     /^ *Tests +.*failed/ { print t" :: "$0 }' stripped.txt | sort -u

# which task owns an unhandled-errors section
awk '/AFFECTED_TASK_OUTPUT_BEGIN/ { match($0,/task="[^"]*"/); t=substr($0,RSTART+6,RLENGTH-7) }
     /Unhandled Error/ { print "banner in: " t }' stripped.txt

# every failing task
grep 'AFFECTED_TASK_OUTPUT_BEGIN' stripped.txt | grep -v 'exitStatus=0'
```

## The general lesson

The instrument was never broken. The regex was right, the ANSI handling was right, the file was real and readable. It simply could not contain the thing being looked for.

"Is my method sound?" is the wrong question, because a sound method pointed at the wrong artifact yields a clean, confident, wrong number. The question that catches this is: **is this artifact capable of containing what I am looking for?** For a log, that is answerable in one line — count the lines that could only exist if the thing were present (`grep -cE '^ *Tests +[0-9]+ (failed|passed)'`). Zero vitest summary lines anywhere in a file means it holds no test output at all, and no result you derive from it is about tests.

The same shape recurs in this repo: a case-insensitive grep counting prose as evidence, a marker that looks like the banner you are hunting but is a different subsystem's, a count that agrees with the story you already have. When a grep returns a number that confirms what you expected, spend one extra call reading the matched lines instead of counting them.
