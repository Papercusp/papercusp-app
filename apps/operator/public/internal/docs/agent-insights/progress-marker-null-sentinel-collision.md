# A shared \"pending\" sentinel for two different nulls makes a finished task look unresolved
URL: /internal/docs/agent-insights/progress-marker-null-sentinel-collision

A progress/heartbeat line that renders a not-yet-known field and a definitely-null (not-applicable) field with the same fallback string makes a clean, completed outcome unreadable from a genuinely-still-open one — the exact false-red shape behind EI-21048499991398082.

## The trap

Node's `child_process` `close(code, signal)` event is a **mutually exclusive pair**: a
normal exit sets `code` to a number and `signal` to `null`; a signal-kill sets `code` to
`null` and `signal` to the signal name. At the moment `close` fires, a `null` in either
field has a **definite meaning** — "not applicable, the other field is what happened" —
not "unknown".

`scripts/affected-tests.mjs`'s per-task liveness pulse (`AFFECTED_TASK_PROGRESS`) used to
render both fields the same way at every call site:

```js
`exitStatus=${status ?? "pending"} signal=${signal ?? "pending"}`
```

Before the task closes (started/running/watchdog-extended/watchdog-firing), `status` and
`signal` really are both unknown, so `"pending"` is correct there. But the SAME line of
code also renders the TERMINAL tick, where `status`/`signal` are the real values from
`close(code, signal)` — and a clean, exit-0 pass has `signal: null`, which the `?? "pending"`
fallback collapsed onto the exact same string used for "not yet known". The result:

```
AFFECTED_TASK_PROGRESS state=finished task="@papercusp/sse :: test" exitStatus=0 signal=pending
```

`state=finished` and `exitStatus=0` both say this task is DONE and PASSED. `signal=pending`
says the opposite — it reads as "this task's fate is still unresolved". A human or LLM
triager skimming a large aborted-run log (EI-21048499991398082: \~17K lines, the run itself
killed by an unrelated disk-exhaustion event) sees the ambiguous field and concludes the
task's outcome was "swept into the failed list wholesale", even though the machine-computed
verdict (a separately, correctly block-anchored parse of the run's OWN terminal summary)
never actually misclassified it. The diagnosability gap alone produced the false-red report
and the release-fixer churn — no bug in the verdict-computation path was needed.

## The generalizable rule

Any observability line that reports a value which is **sometimes genuinely unknown** (before
an event settles) and **sometimes definitively absent** (after it settles, because a sibling
field is what applies) needs **two distinct sentinels**, not one shared fallback. Collapsing
them makes "still in flight" indistinguishable from "finished cleanly" to a reader who has
only that one line — and readers (fixers, triagers, future log-summarizers) do read one line
at a time under time pressure; they will not re-derive the distinction from `state=`.

Concretely: pass a `settled` (or equivalent "this is the terminal call") flag through to the
formatter, and render `null` as the terminal sentinel only when `settled` is true; keep the
pre-settlement sentinel for every earlier call.

## Where this is fixed

`scripts/lib/task-progress-line.mjs::formatTaskOutcomeFields({ status, signal, settled })` —
`settled: false` (all pre-close progress ticks) → both fields render `"pending"` on a `null`.
`settled: true` (the terminal `child.once("close", ...)` call only) → a `null` field renders
`"none"` instead. Regression test:
`packages/operator-core/lib/__tests__/affected-tests-task-progress-line.test.ts`.

## Check for the same shape elsewhere

Before adding a new progress/heartbeat/status line with a `value ?? "<placeholder>"` fallback,
ask: does this line get emitted BOTH before an event settles AND at/after it settles, with the
SAME fallback string either time? If yes, and a `null` at settlement has a real meaning (not
"unknown"), split the sentinel the way this fix does.
