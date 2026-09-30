# Two harness dispatch models: mug/cup `coding` (live) vs `coding-factory` DBOS orchestrator — don't conflate them
URL: /internal/docs/agent-insights/two-dispatch-models-mug-cup-vs-coding-factory

When reasoning about how a pot scales agents to its work-item backlog, there are TWO different mechanisms in the repo. The mug/cup pot (`coding`, kind:pot, spine.decider:mug) is the live, actively-developed path. The DBOS-orchestrator `coding-factory` (decider:director + a `dispatch:` block, driven by orchestrator-loop.ts) is a DIFFERENT model and is NOT the path in active use (owner, 2026-06-24). `work` extends `coding`, so anything built on `work` inherits the mug/cup model — do not base its dispatch design on orchestrator-loop.ts.

:::caution\[Superseded — BOTH models described here are now off the table]
This page's headline claim is the one that broke: it says the mug/cup `coding` pot
is **"the live, actively-developed path."** That has been false since 2026-08-09.
The Mug, Kettle and Cup/nursery tier is RETIRED (owner-directed) and held off by
the `papercusp-mug-kettle-system` flag, whose default-OFF **is the delivered end
state** — not unfinished work awaiting a flip.

So the page now presents a choice between two dispatch models where **neither is
the answer**: `coding-factory` was already not in use, and mug/cup is retired.
Nothing auto-scales agents to a work-item backlog any more. Work advances because
an **su session** works it — interactively, or under AUTO / GOAL mode.

**Still true and worth reading:** the mechanical contrast between the two models,
and specifically that `work` extends `coding` so anything built on `work` inherits
the mug/cup shape rather than `orchestrator-loop.ts`. That inheritance fact still
governs how those blueprints are wired — it just no longer describes a running
system.

Canonical account: [The Mug · Kettle · Cup tier is RETIRED](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired).
:::

## The trap

You ask "does the framework auto-scale agents to a work-item backlog, or does
something hand-place them?" — read `packages/operator-core/lib/dbos/orchestrator-loop.ts`,
see that it auto-dispatches a durable pipeline per ready work-item up to a
blueprint-declared `dispatch.concurrency` (30s backstop tick + `refillHarnessOnSettle`),
and conclude **"the framework already autoscales — no glue needed."**

That conclusion is **true for `coding-factory`, false for the pots actually in
use.** `orchestrator-loop.ts` is the DBOS-orchestrator / "factory" dispatch path.
It is **not** the path a mug/cup `coding` pot runs on.

## The two models

|                              | mug/cup pot (`coding`)                                                                                                      | factory (`coding-factory`)                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `kind`                       | **`pot`**                                                                                                                   | harness (default)                                                                               |
| `spine.decider`              | **`mug`**                                                                                                                   | `director`                                                                                      |
| `dispatch:` block            | —                                                                                                                           | **yes** (`{ concurrency, priority, readiness, costCapUsd, safetyCeiling }`)                     |
| Who scales agents to backlog | **the Mug** — wakes (`pot/wake.ts`), reads the frontier, places/spawns cups via fleet placement (`fleet/operator-spawn.ts`) | the **DBOS orchestrator** (`orchestrator-loop.ts`) — deterministic, blueprint-`dispatch`-driven |
| Status                       | **LIVE — actively used + developed**                                                                                        | a different model; **per owner (2026-06-24) may not be working / not the path in use**          |

Verify the discriminators directly in the YAML: `coding` declares `kind: pot` +
`spine.decider: mug`; `coding-factory` has no `kind: pot` and declares
`spine.decider: director` + a `dispatch:` section.

## Why it matters: `work` extends `coding`

`libs/papercusp/packages/harness/blueprints/work/blueprint.yaml` is
`extends: coding` (`kind: pot`). So **anything built on `work` inherits the
mug/cup model**, not the factory. An internal ops pot (one that `extends:
work`) is therefore a mug/cup pot: its analysts are scaled to the
domain backlog by the **Mug + fleet placement**, governed by the pot
blueprint's placement / wake / fleet knobs and the Mug prompt — **NOT** by
`orchestrator-loop.ts`.

## The rule

When you need to know how a pot scales workers to its backlog:

1. Check the blueprint's `kind` + `spine.decider`. `kind: pot` + `decider: mug`
   → **mug/cup model** → the dispatch mechanism is the Mug + `fleet/*` +
   `pot/wake.ts`. Read those, not `orchestrator-loop.ts`.
2. Only a `director` + `dispatch:` blueprint (the `coding-factory` lineage) is
   driven by the DBOS orchestrator-loop.
3. **Do not base a design on `coding-factory` / `orchestrator-loop.ts`** — it is
   not the path in active use and may not be working. Model on the live `coding`
   mug/cup pot (and the things that `extends: coding`, like `work`).

> This is exactly the kind of finding that survives a single confident
> code-read getting it wrong: `orchestrator-loop.ts` *is* real and *does*
> autoscale — for the wrong blueprint. The discriminator is `kind`/`decider`,
> not "is there dispatch code somewhere."
