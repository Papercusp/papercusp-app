# Steering & chat
URL: /internal/docs/harness/steer-and-chat

Which surface to use to steer running agents — durable messages, role-scoped chats, live coord nudges, turn interruption, and human gates.

The first-generation harness had one steering surface: a chat box in the
retired web UI. Today steering is several purpose-built surfaces; picking the
right one matters because they differ in durability, latency, and who reads
them.

## Which surface for which job

| You want to…                                                        | Use                                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Leave durable direction/context for whoever works a feature next    | `work_items:comment` / `work_items:checkpoint` (the work-item ledger) |
| Have an interactive conversation with a role agent inside a harness | `agent_chats:*`                                                       |
| Nudge a *live* agent right now (or wake an idle one)                | `coord:send` (with `wake: 'required'`/`'optimistic'`)                 |
| Make a running agent stop / wrap up                                 | `turn:interrupt`                                                      |
| Answer a question an agent asked                                    | the decision card / `conversations:answer` / `coord` escalation       |
| Steer the whole Pot (not one agent)                                 | the operator chat surface                                             |

## Durable direction — the work-item ledger

Durable, work-scoped direction lives **on the work-item**, not in a mailbox.
`work_items:comment` appends to the item's thread; `work_items:checkpoint`
writes the in-flight carry-note that is **re-injected on the item's next
invocation** — so direction reaches a
[fresh context](/internal/docs/harness/decisions/fresh-contexts) that didn't
exist when you wrote it, which is the property a mailbox was there to provide.
Prefer the checkpoint for "here is where I left off"; prefer a comment for
findings and rulings others need to read.

:::caution\[`messages:*` is retired]
The work-item MAIL surface — `messages:send` / `messages:dismiss` /
`messages:inbox` / `messages:outbox` and their `cross_harness:` analogs — was
**retired 2026-07-26** (WI-6097). It was not broken; it lost to `coord:send`,
which carried roughly 400× its traffic, while the mail plane took zero writes
in its final 30 days. Do not wire new code to it or reintroduce it. All 222
existing rows are preserved — this was code removal only. Restore notes:
`_retired/work-item-mail/RESTORE.md`.
:::

## Role-scoped chats — `agent_chats:*`

For an interactive back-and-forth with a role agent inside a harness (the
"pair" primitive): `agent_chats:create` opens a persistent chat,
`agent_chats:chat` streams a turn
(`packages/operator-core/lib/agent-tools/agent_chats/chat.ts` — transcripts,
cost rollup, and feature-lock checks handled server-side), and
`agent_chats:send_message` is the fire-and-forget non-streaming append used
by autonomous dispatches. Use this when you want a conversation; use the
work-item ledger (`work_items:comment` / `work_items:checkpoint`) when you
want durable direction.

## Live coordination — `coord:*`

`coord:send` reaches a *live* (or wakeable) agent's coordination inbox;
deltas are injected into the recipient mid-turn after its tool calls. The
default (no `wake`) is inject-only — the message lands in the inbox and is
seen on the recipient's next natural turn. Set `wake` to *also* re-invoke an
idle recipient now; agents are armed for inbox-wake at session start. The arg
carries an intent (`'required' | 'optimistic'`), not a plain toggle:

* `wake: 'required'` — the wake MUST land. A clean miss (it reached wakeable
  addressees but no awake/watching session, and none were staged for a Pause)
  returns `recipient_absent: true` plus an explanatory note rather than
  failing silently. The message is still injected to the inbox for the next
  turn; only the re-invoke missed.
* `wake: 'optimistic'` — silent best-effort over a durable backstop (wake if
  present, shrug if not — e.g. the Mug survey re-dispatches anyway). A miss
  is *not* surfaced; the inbox row persisted regardless.

The legacy boolean still coerces: `true` → `'required'`, `false`/omitted → no
wake. `coord:escalate` raises a durable escalation a human (or the operator)
must resolve. Don't use coord for state that must outlive the session —
that's what messages and work items are for.

## Turn interruption — `turn:interrupt`

To make a running agent stop, `turn:interrupt`
(`packages/operator-core/lib/agent-tools/turn/interrupt.ts`) supports two
modes — operator-mediated, reason-required, audited, and storm-rate-limited
(max 10 interrupts per actor in a rolling 60s window, sourced from the audit
log):

* **cooperative** — injects a high-priority `yield` line into the target's
  coord stream; the agent finishes its atomic step, releases locks,
  checkpoints state, and ends its turn. But when the target holds file locks
  (a critical section), the cooperative interrupt **DEFERS** — it returns
  `deferred: true` and injects *no* yield, so the peer can finish its atomic
  edit and release its locks. Retry shortly, or escalate to `force` (which
  warns it may orphan a half-written edit).
* **force** — ends the turn *now*, mid-thought (Ctrl+C to a managed pty /
  SIGINT headless); no checkpoint is guaranteed.

You cannot interrupt your own turn.

## Human gates: questions, escalations, approvals

Agents pause for humans through structured gates rather than free chat: a
mid-tool decision card (`ctx.askUser` / `chat:ask_choice`; with the
`papercusp-inbox-durable-escalations` flag the card is also mirrored to a
durable coord escalation so it can be answered later from the inbox),
knowledge-first questions routed by topic (`coord:ask` → a conversation
answered via `conversations:answer`), pipeline escalations
(`harness:escalation` surfaces the blocker; resolution re-enters the
pipeline), and plan items marked `needs-human` (which also block a DONE
finalization — see [Smoke-test gate](/internal/docs/harness/smoke-test) for
the gate family).

## Observing without steering

`fleet:bee_mail` renders what a specific agent has received/sent (the
cup-dossier view) — for *inspection*, not for reading your own inbox
(`coord:inbox`) or deriving who's-on-what (`fleet:assignments`). The
fleet-wide steering surface — scheduling, placement, prioritization — is the
operator/Mug's job; see
[Operator persona](/internal/docs/agents/operator-persona).
