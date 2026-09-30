# @papercusp/event-reaction

A generic, **durable ECA reaction engine** layered over [`@papercusp/rules`](../rules).
`@papercusp/rules` decides _what_ should fire (the pure matcher); this lib decides
_how_ a reaction is **scheduled, loop-protected, deduplicated, and durably
executed** — the parts a real "when X happens, fire Y" system needs but that
must stay out of the pure matcher.

It is **host-agnostic**. Dispatch (how a fire descriptor becomes a real call),
the durable runner (e.g. a workflow queue), and the idempotency store are all
**injected as ports**. The lib imports nothing but `@papercusp/rules`.

## What it adds over a pure rules engine

| Concern | This lib |
|---|---|
| **Reaction metadata** | `ReactionRule` = a `@papercusp/rules` `Rule` + `{ mode, onlyOnSuccess, source, capability, dedupKey }` |
| **Registry** | `ReactionRegistry<TEvent, TFire>` — a thin, inspectable wrapper over `RulesEngine` (`add/remove/rules/rulesFor/match/describe/clear`) |
| **Loop protection** | `guardReaction` — caps cascade depth (`MAX_REACTION_DEPTH`) and rejects cycles, carrying a `ReactionCause` chain |
| **Scheduling** | `runReactions` — match → success-gate → loop-guard → schedule each off the hot path; `scheduleReaction` routes durable-vs-in-process with an automatic in-process fallback so a durable hiccup never drops a reaction |
| **Idempotency** | `computeDedupId` (deterministic `reaction:<root>:<rule>[:<key>]`) + a `ReactionStore` port (`claim`/`release`/`markFailed`) |
| **Durable execution** | `executeDurableReaction` — the claim → fire → release-on-failure body a durable step runs (idempotent under at-least-once delivery) |

## Generic over the event + fire types

```ts
import { ReactionRegistry, runReactions, type ReactionRule } from '@papercusp/event-reaction';

interface MyEvent { tool: string; ok: boolean; payload: unknown; cause?: ReactionCause }

const registry = new ReactionRegistry<MyEvent>({ keyOf: (e) => e.tool });
registry.add({ id: 'r1', on: 'thing:done', fire: 'other:tool', args: (e) => ({ … }) });

// in your post-event hook:
runReactions({
  actions: registry.match(event),
  event,
  succeeded: event.ok,
  cause: event.cause,
  rootRunId: event.runId,
  fireInProcess: async ({ fire, args }) => { /* dispatch through your host */ return { ok: true }; },
  // optional durable seam:
  durable: { enabled: () => dbosOn, run: (input) => enqueueWorkflow(input) },
  log: (m) => console.warn(`[reactions] ${m}`),
});
```

The host supplies the `fireInProcess` port (its dispatcher), an optional `durable`
port (its workflow runner), and — for the durable executor — a `ReactionStore`
(its idempotency ledger). Nothing in this lib knows about Postgres, DBOS, MCP,
or any specific dispatcher.

## Provenance

Extracted from the Papercusp operator's `lib/events` event-reaction system
(`event-reaction-system-2026-06-04`) into a generic lib per
`generalize-libs-to-generic-2026-06-05` (D-003 row #1). The operator keeps a thin
adapter that injects its dispatcher (`@papercusp/agent-mcp`), its DBOS durable
runner, and its Postgres dedup ledger — behaviour is identical.
