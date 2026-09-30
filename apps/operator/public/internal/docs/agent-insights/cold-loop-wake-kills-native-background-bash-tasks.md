# Native Bash background tasks survive context resets but not process replacement — verify before relaunching (EI-19333267623373946)
URL: /internal/docs/agent-insights/cold-loop-wake-kills-native-background-bash-tasks

Native Bash run_in_background task ids survive context-reset/recycle wakes that reuse the host process, but not a genuinely replaced CLI process; verify process identity and logs before relaunching to avoid duplicate jobs.

## The report (EI-16611)

> **Scope correction (EI-19333267623373946):** A cold wake is not synonymous with a new CLI process. A context RESET/RECYCLE wake rebuilds the context while reusing the host process, so native children and their task registry can survive. The task id is lost only when the CLI process is actually replaced; verify the process and artifact before relaunching.

Driving a fix in a **cold-carry** AUTO loop, one wake launched a long-running
integration test via the native Bash tool's `run_in_background: true` (task id
e.g. `bfdsrowp3`) and checkpointed `"await background task result"` as the
`next` action in its `loop:checkpoint` carry-note. The loop's next fire was a
**cold carry-respawn** (fresh context **and a new process**, carry-note-only continuity — by design,
see [engine-managed-loops](/internal/docs/agent-insights/engine-managed-loops)).
The successor called `TaskOutput('bfdsrowp3')` and got `"No task found with ID:
bfdsrowp3"` — the task, its output, and any partial progress were gone.

## Root cause: the registry is in-process memory, not a papercusp store

Unlike `work_items:checkpoint` / `loop:checkpoint` (rows in Postgres,
re-injected on the next read by design) or even `capability:bash`'s job
registry (`bash-jobs.ts`, living in the single long-lived **operator** process —
see
[capability:bash background jobs across calls](/internal/docs/agent-insights/capability-bash-background-jobs-across-calls)),
the native Claude Code Bash tool's `run_in_background`/`TaskOutput` bookkeeping
lives **inside the CLI child process's own memory**. That process is Anthropic's
own binary, not papercusp code — there is nothing in this repo to persist it
with. It survives for exactly as long as that one OS process keeps running and
keeps taking turns itself; the moment that process is replaced by a different
one, the registry is gone, even when the *logical* session/transcript
continues.

\*\*Only transitions that actually replace the CLI process lose native background tasks; a context
RESET/RECYCLE wake can reuse the existing process and preserve them:

| Trigger                                                                                                                                                                                                              | What happens to the OS process                                                       | Background task survives?                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Wake lands on the "alive + injectable pty" rung (`fireLoopWake`'s liveness ladder, [engine-managed-loops](/internal/docs/agent-insights/engine-managed-loops)) — the common warm case                                | Same process, just injected a turn ("press enter")                                   | **Yes**                                                                      |
| Wake lands on the "process exited → `claude --resume <sid>`" rung — still a **warm** loop                                                                                                                            | Old process is dead; `--resume` boots a **new** process reading the saved transcript | **No** — new process, empty registry, even though it's "the same session"    |
| **Cold**-carry loop fire (`loop:arm { carry:'cold' }`)                                                                                                                                                               | Context reset/recycle rebuilds context but reuses the host process                   | **Yes** — unless the host process dies and the wake takes the respawn ladder |
| Compaction carry-respawn / cold-loop RECYCLE (`psu-pty-host.mjs`'s `recycleChild`, see [carry-respawn must reanchor native session id](/internal/docs/agent-insights/carry-respawn-must-reanchor-native-session-id)) | Old child killed, fresh `--session-id` minted for the successor                      | **No**                                                                       |
| `session:request-compaction` (the deliberate P-022 carry-respawn cut)                                                                                                                                                | Same shape as above                                                                  | **No**                                                                       |

So "same session" in the
[mid-turn-delivery backgrounding matrix](/internal/docs/agent-insights/coord-mid-turn-delivery)
(`"the harness re-invokes the SAME session when it exits"`) is true for the
*ordinary* continuous-turn case that table is about — it does **not** mean
"survives a loop/carry process boundary." Read literally out of context it's
easy to over-generalize into exactly this bug.

## The fix: treat CLI process replacement—not context reset—as the boundary

1. **Do not assume a native task id survives a CLI process replacement.** Checkpointing `await background task <id>` across a carry-respawn, a warm wake whose old process exited and was resumed with `--resume`, or `session:request-compaction` is unsafe: the successor has an empty native registry. A context-reset/recycle wake that reuses the same host process is different — the task may still be alive. Before relaunching, verify the actual process and artifact below.
2. **If the work fits in one wake, run it in the foreground instead.** A
   blocking `Bash` call before you checkpoint/end the turn is simpler and
   strictly safer than backgrounding-then-hoping the same process resumes.
3. **If the work genuinely must outlive a wake boundary, don't use native
   `run_in_background` for it — use `capability:bash { run_in_background:
   true }`.** That job lives in the **operator's** long-lived process, entirely
   independent of your CLI session's process lifecycle, so it survives your
   own loop/carry respawns (though not an *operator* restart —
   `capability:bash_output`'s `stranded_by_operator_restart` reason already
   distinguishes that, and see
   [capability:bash background jobs across calls](/internal/docs/agent-insights/capability-bash-background-jobs-across-calls)
   and
   [native Bash task killed under host overload](/internal/docs/agent-insights/native-bash-background-task-killed-under-host-overload)
   for its own caveats). Checkpoint the `bash_id` (not a native task id) as the
   next action — it's a stable, poll-from-anywhere reference.
4. **Polling within the same turn** (no wake boundary crossed) is unaffected —
   native `run_in_background` + `TaskOutput` remains the right, lightweight
   choice there.

## Before relaunching: verify the process, not the wake label

A cold wake alone does not prove that a native background job is gone. Check the command and its PID before starting a replacement:

```bash
ps -eo pid,etime,args --sort=start_time | grep '[y]our-cmd'
```

Do not pipe that query through `head`: a newly launched job has the highest PID and sorts last, so `head` can hide exactly the process you are trying to find. If the original process or its log is still active, keep it and do not launch a duplicate. If it is absent, treat the native task id as stale and relaunch only after checking the artifact for partial output.

No code change is proposed for the native Bash tool itself: it is Anthropic's
own CLI internals, outside this repo, and "make it durable across an arbitrary
process replacement" is not something papercusp can implement from here. The
durable fix available to us is this documented pattern, plus the
`capability:bash` escape hatch for the genuinely-must-survive case.

## Compounding trap 1: a "wrapper shell" completion notification can precede the real work finishing

A distinct but related gotcha (WI-5766/WI-5775, 2026-07-25), independent of any
respawn: the `cmd & echo launched pid $!` backgrounding idiom run via native
`Bash { run_in_background: true }` backgrounds the *inner* `cmd`, but the tool's
own tracked process is the *outer wrapper shell* — which exits (and fires a
"task completed" notification) the instant it has echoed the launched pid,
**not** when `cmd` itself finishes. A "task X: COMPLETED exit code 0"
notification is therefore *not* proof the real work is done; it only proves
the wrapper returned. Combined with the process-respawn loss above, this
produced a stale carried checkpoint claiming a job had completed when the real
child (verified via `ps`/`kill -0` on its actual pid) was still running minutes
later.

**Never background a command by wrapping it in your own `&`** — pass the
command directly with `run_in_background: true` and let the tool track the
real process; if you must wrap, treat "task completed" as proof only that the
wrapper exited and independently confirm the real work via its own pid/log/exit
marker before trusting or checkpointing a "completed" claim.

## Compounding trap 2: a stale notification for a DEAD (prior-session) task can assert false success (EI-19314563321733768)

A sharper variant of the same root cause, reported 2026-08-02: this doc already
establishes that `TaskOutput('<id>')` on a successor returns `"No task found
with ID: ..."` for a native background task whose owning process is gone — that
was independently reproduced the same day (two ids, both `"No task found"`,
zero ambiguity). The variant here is worse because it is **not** an obvious
miss:

> A cold loop wake reset context. The carry-note's "Next action" pointed at a
> native background id holding a `lint:tsc` result and correctly warned it
> might be dead. The agent re-ran the typecheck instead of trusting it. Then,
> \~20 minutes into the NEW session, a task-completion notification for that
> same dead id arrived anyway: `Background command "..." completed (exit code 0)`. Two more stale notifications, from two other dead prior-session ids,
> did the same thing in the same session.

So the delivery is not consistent: the same class of dead reference can surface
either as a clean `TaskOutput` miss (this doc's original report) **or** as a
notification that actively asserts `exit code 0` success, carrying the
original human-readable task description, into a session that never started
that task and has no way to know it's stale.

:::caution\[Correction (2026-08-02, WI-6944) — the original report's "0-byte artifact" detail was WRONG, and so was the tell derived from it]
EI-19314563321733768 originally reported that the notifications arrived next to
**0-byte** output files, and concluded that an empty artifact is the tell. Both
halves are false, and the second is dangerous.

Re-reading the three cited artifacts directly: they are **2470, 1249 and 1614
bytes** — full, rich, correct output. Not one is empty. And **all three end in
`===TSC_EXIT:1===`** with `❌ 1 NEW file(s) have type errors`. They *failed*,
and every one of their notifications said `completed (exit code 0)`.

An empty artifact is therefore **not** the signal, and treating it as one is a
false negative test: it tells you a healthy multi-KB log means the notification
can be believed, which is precisely how you accept `exit code 0` for a failed
gate check. The real mechanism is trap 3 below, it has nothing to do with
session boundaries, and it fires on live jobs too.
:::

**Why this can't be fixed by suppressing or rewriting the notification from
inside this repo.** The natural-sounding fixes — "don't deliver a
completion notification for a task whose owning session no longer exists," or
"tag it as belonging to a prior session" — both require intercepting and
mutating content the Claude Code **client** injects into the transcript.
Claude Code's `Notification` hook (the one hook type that fires on this event
— see `ask-gate-mirror.sh`'s Notification branch for the one other consumer
of it in this tree) is **observational only**: every existing use of it is a
side-effect (open/touch a mirror row in `sessions:ingest-gate-event`), and
none of Claude Code's hook types return a decision that edits or suppresses
what the model is shown for a `Notification` event the way `PreToolUse` can
block a tool call. There is nothing to change in this repo's hook layer
that would stop the notification text itself from asserting success — same
conclusion as the base report above, for the same reason (CLI-internal
delivery, not a papercusp surface).

**The durable mitigation is therefore a verification habit, not a
suppression mechanism:** treat ANY background-task completion notification —
regardless of what exit code or description it carries — as unverified until
you independently confirm the artifact. Concretely, before relying on a
"completed exit code N" notification for gating decisions:

1. **Check whether you (this turn, this session) actually started that task.**
   If the id/description doesn't match anything you background this session,
   it is very likely a stale notification for a dead prior session's job —
   treat its claimed exit code as unverified regardless of what it says.
2. **Read the VERDICT out of the artifact's content — never the exit code out
   of the notification.** There is no file-size tell: the three artifacts
   behind the report above were 1249–2470 bytes of perfectly real output and
   still sat under a false `exit code 0` (see the correction above, and trap 3
   below for why). Look for the thing that states the outcome — your `===EXIT:N===`
   marker, a `❌`, the tool's own summary line — and if the artifact contains no
   explicit verdict, the run is UNVERIFIED no matter how healthy the log looks.
3. **Prefer `capability:bash` + `bash_id`** for anything that must survive a
   wake boundary (per the fix above) — its `capability:bash_output` read
   distinguishes `stranded_by_operator_restart` / `job_process_gone` from a
   real result, which a bare notification cannot.

## Compounding trap 3: the notification's exit code is the LAST command's — so your own exit-marker `echo` erases the failure (WI-6944)

This is the mechanism behind trap 2, and it is **not** about session boundaries
at all. It fires on live jobs, in your current session, every time.

A completion notification reports the exit status of the **whole command line
you submitted**. In a `;`-chain that is the status of the **last** command. So
the moment you append anything — an exit marker, a `tee`, a timestamp, a
`ls -la` to confirm the artifact — the notification stops reporting your
command and starts reporting the trailing one, which essentially always
succeeds.

```bash
$ bash -c 'false; echo "===EXIT:$?==="'
===EXIT:1===
# wrapper shell exit code: 0     <-- the failure is gone

$ bash -c 'false'
# wrapper shell exit code: 1     <-- control
```

End-to-end through the real notification channel (job `bnmntj9o4`, 2026-08-02):
command `sleep 2; false; echo "===PROOF_EXIT:$?==="` → artifact contains
`===PROOF_EXIT:1===` (19 bytes, non-empty, correct) → notification:
**`completed (exit code 0)`**.

**The irony is the part worth remembering: the `echo "===EXIT:$?==="` marker
you add precisely so the log carries a trustworthy verdict is the exact thing
that destroys the notification's exit code.** You reach for it when you care
most about the answer — a gate check, a typecheck before closing a work-item —
which is when a false green is most expensive. That is how three failed
`lint:tsc` runs came to be reported as `exit code 0` above.

### The fix: end the line with `exit "$rc"`

Keep the marker — it is the right instinct, and per rule 2 the artifact's
verdict is what you should be reading anyway. Just restore the exit code on the
way out, which costs one clause:

```bash
cmd > /tmp/out.txt 2>&1; rc=$?; echo "===EXIT:$rc===" >> /tmp/out.txt; exit "$rc"
```

Now **both** channels are truthful: the artifact states the verdict explicitly,
and the notification's exit code is `cmd`'s own. Without the trailing
`exit "$rc"`, a green notification means nothing more than "the last thing on
my command line succeeded."

:::note\[Pipelines have the same defect, differently]
`cmd | tee log` exits with `tee`'s status, not `cmd`'s — so a failing `cmd`
reads as success. `set -o pipefail` fixes that case; it does **not** fix the
`;`-chain case above, which needs the explicit `exit "$rc"`.
:::
