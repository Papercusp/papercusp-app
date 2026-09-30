# Stop polling — await the event (events:catalog + sugar verbs)
URL: /internal/docs/agent-insights/events-await-vs-poll

The await-event primitive already exists and is barely used: agents poll dev:pipeline_position / dev:build_status / a peer's status because they never find the event key that already fires. The fix is discoverability — events:catalog lists every awaitable key, and named sugar verbs (deploy:await, work-item:await, …) build the key for you. Register, END YOUR TURN, get re-invoked when it fires.

## The mistake: polling for something that already fires an event

The single most common waste in a fleet session is **re-polling** for a
condition that is already announced as an awaitable event:

* Re-reading `dev:pipeline_position` every few minutes to see if "my change is
  live on `:3070`" — while `release:deployed` fires the moment it lands.
* Re-reading `dev:build_status` to see if the gate went green — while
  `release:green` / `green-checkpoint:red` already fire the verdict.
* Re-reading `work_items:get` for a peer's item — while `work-item:done:<id>`
  already fires when it settles.

A usage audit (`tool_invocations`, `tool_name='events:await'`) found agents
**barely use the primitive** — not because it doesn't work (it's durable +
liveness-adaptive: it wakes a live pty, resumes an exited session, or nudges an
inbox), but because they never **find** the key. The gap was discoverability,
not mechanism.

## The fix: one read, then sleep

**Before you poll, run `events:catalog`.** It lists every awaitable key family:
the key template, a ready-to-copy `events:await` example, what it means, who
emits it, whether it fires *today*, and the poll it replaces. If the thing
you're about to poll for is in there, don't poll — arm the await and **end your
turn**. You are re-invoked when it fires (or at the deadline).

```
events:catalog                          # what can I wait on?
events:await { event: "release:green" } # arm it
# …end your turn. You wake when the gate resolves.
```

## Prefer the named sugar verbs

For the common waits there's a thin named verb that **builds the key for you**
(sourced from the same catalog — the single source of truth):

| Want to wait for…                 | Sugar verb                       | Resolves to                                           |
| --------------------------------- | -------------------------------- | ----------------------------------------------------- |
| my sha live on `:3070`            | `deploy:await { sha? }`          | `release:deployed:<sha>` (+ `release:deploy-failed`)  |
| the green gate's verdict          | `checkpoint:await`               | `release:green` (+ `green-checkpoint:red`)            |
| a work item to change / settle    | `work-item:await { id, state? }` | `work-item:status:<id>` (or `:done` / `:blocked` / …) |
| a service to recover              | `service:await-up { name }`      | `service:up:<name>`                                   |
| my edit committed                 | `git-sync:await { sha? }`        | `git-sync:committed:<sha>`                            |
| a plan item done                  | `plan-item:await { slug, id }`   | `plan-item:done:<slug>:<id>`                          |
| my fleet to drain (then loop:end) | `fleet:await-drained { slug }`   | `fleet:drained:<slug>`                                |

The dual-outcome verbs (`deploy:await`, `checkpoint:await`) arm awaits on **both**
the success and failure keys — mutually exclusive, so you wake exactly once,
either way. These are \~convenience wrappers over `events:await`, **not** a second
subscription system — `coord:wake` / `coord:dispatch` hide the
`coord:inbox-wake:<owner>` key the same way.

## Don't

* **Don't sit in a poll loop** for a deploy / gate / commit / peer item. Arm the
  await and end your turn — a wake is a turn; the pump paces mass unblocks.
* **Don't hand-hold a raw PG `LISTEN`.** Agents park/end between turns and would
  miss events fired while asleep; the operator holds the connection and *wakes*
  you. That's the value Postgres doesn't provide (see the plan's D-004).
* **Don't invent a key.** If the catalog marks a family `awaitable_now: false`,
  its emitter is being wired — the key shape is stable but nothing fires it yet.

## Why it's structured this way

`events/await/catalog.ts` is the **single source of truth**: the `events:catalog`
tool, the `awaitable:` hints the poll-site tools now return, and the sugar verbs
all read it. So a key shape lives in exactly one place — and a future unification
of the await primitive with the ECA reaction engine is a *form* change, not a
rebuild (event-await-discoverability-and-coverage-2026-07-03, D-005).
