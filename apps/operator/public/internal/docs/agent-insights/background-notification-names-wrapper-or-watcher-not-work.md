# Background-task notifications name the WRAPPER or the WATCHER, not the WORK — a terminal-sounding message about the wrong subject (EI-21855015171700096)
URL: /internal/docs/agent-insights/background-notification-names-wrapper-or-watcher-not-work

A run_in_background completion notification always reports on the LITERAL command you launched, not on whatever that command backgrounds further, and not on whatever it is watching. Two concrete traps: (1) `nohup /tmp/script.sh &` inside a run_in_background call reports \"completed (exit code 0)\" within seconds because the LAUNCHING shell exited — the nohup'd script is still on file 1 of 8. (2) A `until kill -0 <pid>; do sleep; done` watcher gets reaped by the harness mid-wait and reports \"killed / was stopped\" — which reads as \"the job ended\" but is the opposite: the watched job was alive and minutes from its own deadline. Distinct from the pipe/exit-code-lying trap (background-test-pipe-exit-code-trap) and from a task's own death under host overload (native-bash-background-task-killed-under-host-overload) — this is about the notification's SUBJECT being ambiguous, not its exit code being wrong.

## The failure, in one sentence

A `run_in_background` completion notification is a claim about the **literal
command string you launched** — never about anything that command backgrounds
further, and never about anything it is merely watching on your behalf. Two
concrete, independently-repro'd shapes of this bit the same session three
times in 30 minutes (su-9193bb33, WI-882767, 2026-08-30 05:07–05:35Z), and
acting on either notification at face value would have caused real damage.

## Failure A — a detached child reports the LAUNCHER's exit, not its own (x2)

```bash
nohup /tmp/script.sh >/dev/null 2>&1 &
```

run via the Bash tool's `run_in_background: true`. The notification read
**"completed (exit code 0)"** within seconds. That is the *launching shell*
exiting — it forked `script.sh` into the background and immediately returned,
so the wrapper genuinely did complete, successfully, having done nothing but
start the real work. Both times the actual script was still on file 1–2 of 8.
Reading the notification at face value here means reporting a multi-hour test
sweep green before a single file of it has finished.

This is the same shape as `background-test-pipe-exit-code-trap`'s core lesson
generalized one level further: that doc is about a pipeline's LAST STAGE
reporting instead of the stage you meant; this is about the LAUNCHER
reporting instead of the CHILD it detached. Same root cause — the
notification faithfully reports the wait-status of the literal command you
gave it, which was never the thing you actually cared about — different
surface (backgrounding, not piping), so it does not pattern-match on sight to
anyone who has only internalized the pipe version.

## Failure B — a reaped WATCHER reports "stopped", which reads as "the job it watched has ended" (x2)

```bash
until ! kill -0 <pid> 2>/dev/null; do sleep 30; done
```

armed as its own `run_in_background` task, to be notified when a long job
finishes. Both times the WATCHER itself was reaped by the harness mid-wait and
delivered `status: killed` / **"was stopped"** — not `completed`. The natural
reading of "the task that was waiting for the job to end was stopped" is "the
job ended" (that's the entire *point* of arming a watcher). It is the exact
opposite of the truth: the watched job was alive and, both times, **5 minutes
from its own deadline**. Had this been acted on, it would have relaunched a
\~2.5-hour job on top of a still-live one, into a corpus with no serialization
around concurrent writers — two mutators racing the same rows.

Unlike `native-bash-background-task-killed-under-host-overload` (a task
reaped BECAUSE it IS the subject you care about, under genuine host
pressure), the defect here is orthogonal to *why* the watcher died — the
watcher is disposable scaffolding, and its death carries **zero** information
about the job it was watching. A `killed`/`stopped` verdict on a watcher task
must never be read as a verdict on its subject.

## Why this is dangerous rather than merely noisy

The background-task notification is the **only unprompted signal** in this
loop — nothing else tells you a backgrounded command finished. It arrives
with terminal-sounding wording ("completed", "was stopped") in both failure
modes, and in neither case does the message identify **whose** fate it is
reporting (the wrapper's, the watcher's, or the work's). Every phrasing biases
toward "the thing you were waiting for is done" — which is exactly backwards
in Failure B, and exactly premature in Failure A.

## The corrective — decide on the MARKER, never on the notification's subject

1. **Never treat a task notification as a verdict about the work.** It is
   only ever a verdict about the literal command you launched.
2. For a **detached/backgrounded child** (Failure A): confirm with `kill -0 <pid>` against the CHILD's own pid (not the launcher's), AND check the
   work's own terminal marker in its log — the launcher exiting tells you
   nothing about whether the child has even started, let alone finished.
3. For a **watcher** (Failure B): a `killed`/`stopped` verdict on the watcher
   answers nothing about the watched subject. Re-check the watched PID and
   its log's own terminal marker directly; never infer the subject's state
   from the watcher's fate.
4. **`run_in_background` tasks are not durable here.** In the same session, 2
   of 2 armed watchers were reaped mid-wait, while a `setsid nohup`-detached
   script armed at the same time survived (confirmed alive across the same
   window). For anything that must genuinely outlive the calling turn —
   including a watcher you need to survive to delivery — prefer `setsid
   nohup ... &` over a harness-tracked watcher loop, and poll for the result
   independently rather than relying on the watcher's own notification.

## Related, but distinct

* **`background-test-pipe-exit-code-trap`** — the notification's reported
  **exit code number** is wrong (a downstream pipe stage, or an
  unconfirmed harness mechanism, replaces the real command's status). This
  doc is about the notification's **subject** being wrong, independent of
  whether the exit code it reports is even the right command's.
* **`native-bash-background-task-killed-under-host-overload`** — the actual
  long-lived task you care about is killed by host pressure, no watcher
  involved. This doc's Failure B is about a **disposable watcher** dying
  while its subject survives — the opposite direction of information loss.
* **`cold-loop-wake-kills-native-background-bash-tasks`** — covers a
  background task dying *across a context-reset/respawn boundary*. This doc
  is about the notification's wording being misleading *within one
  continuous turn*, no respawn involved.

No papercusp-side code changes this: the notification's wording and the
harness's task-reaping behavior are both internal to the CLI/host, not this
repository. The durable fix is this doc — read the marker you wrote, not the
message the harness sent.
