# Coord lifecycle auto-emits are subscription-scoped (not broadcast)
URL: /internal/docs/agent-insights/coord-emit-subscription-scoping

Lifecycle auto-emits (claim/intent/finding/completion) deliver only to agents watching the plan/topic/work-item via audience selectors, not to '*'. How the @plan/@topic/@object/@file selectors resolve, and the PAPERCUSP_COORD_EMIT_SCOPE kill-switch.

## What it is

The coord **lifecycle auto-emits** — claim ("Taking X"), intent ("now working
on X"), finding (a filed bug), completion ("DONE + tested") — used to broadcast
to `to: ['*']`, landing in **every** agent's inbox (\~360 events/6h). As of
`coord-emit-subscription-scoping-2026-06-05` (Brief 28) they deliver only to the
agents **watching** the relevant plan / topic / work-item. The coordination
signal is preserved; the firehose is gone.

## How it works — audience selectors expanded at send time

The rule `args` functions are synchronous, so watcher-resolution (which needs PG)
can't happen there. Instead the lifecycle rules emit **audience selectors** in
the `to[]`, and `sendMessage` (`agent-tools/coordination/messages.ts`, the single
async choke point every `coord:emit`/`coord:send` flows through) expands them to
concrete ownerIds before persisting. The expanded set is stored on the one
envelope, so the inbox filter (`to.includes(ownerId) || '*'`) is unchanged.

Selectors (pure resolver in `agent-tools/coordination/audience.ts`, PG wiring in
`audience-host.ts`):

* `@plan:<slug>` — plan subscribers ∪ **active presence on the plan**
  (`coord_presence.current_plan_slug`) ∪ subscribers of topics the plan is tagged
  to. The presence half is load-bearing: it makes scoping work **without** every
  agent explicitly subscribing — an agent that merely declared intent on plan X
  still receives X's events.
* `@topic:<slug>` — subscribers of that topic.
* `@object:<kind>:<ref>` — subscribers of that coord object (the full stored
  subscription `target_ref`, e.g. `feature:<harness>#<id>` / `issue:<id>`) ∪ its
  tagged-topic subscribers. Build it with `objectSelector(workItemObjectRef(wi))`.
* `@file:<path>` — active presence whose `current_files` includes `<path>` (the
  file-collision signal, used by intent).
* `@fleet:<slug>` — live (fresh-heartbeat) members of a named fleet, leader
  included; `@fleet-leader:<slug>` — the fleet's CURRENT registry leader
  (liveness-independent). Added 2026-06-30
  (`fleet-broadcast-audience-history-integration`); resolved by the same
  expander, used by fleet-scoped broadcasts rather than lifecycle emits.

Plain ownerIds, `*`, and `human` pass through untouched (a normal `coord:send` is
zero-overhead). Which category emits which selectors:

| Lifecycle     | selectors                                             |
| ------------- | ----------------------------------------------------- |
| intent        | `@plan:<slug>` + one `@file:<path>` per file in scope |
| completion    | `@plan:<slug>` + `@object:<ref>`                      |
| claim         | `@object:<ref>`                                       |
| finding (bug) | `@object:<ref>`                                       |

An empty resolution (no subscribers, nobody present on the plan) → empty `to` →
the row still persists (queryable plan history) but reaches **no inbox**. We never
fall back to `*` — that would re-open the firehose. `coord:emit`'s `to` therefore
allows an empty array (a selector that resolves to nobody), though omitting `to`
on a hand-call still defaults to `['*']`.

## Kill-switch — `PAPERCUSP_COORD_EMIT_SCOPE`

This changes coordination delivery for the whole fleet, so there's a one-flag
revert (`audience-host.ts:audienceMode()`):

* unset / `scoped` (default) — selectors resolve to watchers.
* `broadcast` — every selector collapses back to `['*']` (legacy global
  broadcast). Set it + restart the host if scoping ever starves real
  coordination; no code change or redeploy needed.

## Gotchas

* It deploys to the **live fleet** via the release gate (`:3070` green), not on a
  bare restart — test server edits on staging `:3170` first.
* Claim/finding scope to **object** subscribers only (no plan in the event), so
  they're quiet unless someone explicitly `work_items:subscribe`d. That's fine:
  collision-avoidance is via the work-item's `assignee`/state, not a push. The
  high-volume wins are intent + completion (both carry plan context).
* The companion owner directive (`autoloop-pot-operator-rebuild` D-013): the Pot
  operator triages its inbox first each wake and subscribes a wake on need-human
  arrival — so what *does* reach the operator's inbox is acted on promptly.
