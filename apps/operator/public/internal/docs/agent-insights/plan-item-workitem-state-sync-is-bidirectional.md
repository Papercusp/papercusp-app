# A blocked plan item must sync onto its linked work_item, not just the reverse
URL: /internal/docs/agent-insights/plan-item-workitem-state-sync-is-bidirectional

Why a plan-linked work_item can ping-pong (claim→release→claim) forever, and the bidirectional sync that fixes it — the plan→work direction that reflect-rules never covered.

## Symptom

A fleet member's `scheduler:get_next` keeps hitting a "cooldown-only miss" that is
really 1–2 work\_items being served as claimable, claimed, released, and re-served in a
tight loop — burning real fleet cycles. Each member claims the item, discovers an
owner-gated blocker, releases it, and the next member repeats. The tell: a work\_item
sitting `state: todo` whose linked plan item (`payload.plan_item`) is already
`blocked`/`needs-human`.

## Root cause — the sync was one-directional

`reflect-rules.ts` mirrors a **work\_item's** lifecycle **onto** its plan item (complete →
done, release → todo, …) via the event-reaction system. There was **no reverse**: flipping
the **plan item** to `blocked`/`needs-human` (e.g. `plans:set-status`, recording an
owner-gated blocker) did **not** touch the converted work\_item's own `state`.

`scheduler:get_next` and the `work-item:claimable` gate read **`work_item.state`** (for a
feature-family item, the maintained `work_item_blocked` sidecar keyed off it) — **not** the
plan item's status. So a `todo` work\_item behind a `blocked` plan item stays claimable
forever → perpetual claim/release ping-pong. Two tracking surfaces drifted apart because
sync only flowed one way.

## Fix — reflect the plan-item block/unblock back onto the work\_item

In `plans:set-status` (`setStatusOne`), after the flip commits, sync the linked work\_item
(found via `findConvertedWorkItemByStamp`):

* plan → `blocked`/`needs-human`, work\_item still **claimable** (`todo`/`open`) ⇒ set the
  work\_item `blocked`.
* plan reopened → `todo` **from** blocked/needs-human, work\_item still `blocked` ⇒ return it
  to `todo`.

The decision is a pure, unit-tested helper `planSyncWorkItemState(oldPlan, newPlan,
currentWorkItemState)` — transition- and current-state-gated so a routine re-set never
disturbs a work\_item that is already `wip`/terminal/correctly placed.

## Two gotchas if you touch this

1. **No loop.** The sync calls the **lib** `setWorkItemState` directly, not the
   `work_items:set_state` **tool**, so no tool event fires and no reflect-rule re-entry
   happens. (Even if it did: `reflectedStatus('blocked')` is `null`, and a `todo` re-set of
   an already-todo plan item is a no-op — the cycle terminates either way.)
2. **Family asymmetry.** For **feature-family** work\_items, `blocked` is a real
   scheduler-gating state (the `work_item_blocked` sidecar). For **issue-family** items,
   `blocked` aliases to `open` (EI-450), so setting the state is a harmless no-op — their
   blocked-ness lives in **external blockers** (`work_items:set_blocker`), not the state
   column. A fully family-agnostic block would route the issue family through set\_blocker.

## General lesson

When two surfaces both track the same lifecycle and you build sync between them, build it
**both ways** or state loudly which direction is authoritative. A one-way reflection is an
invitation for the surfaces to drift, and drift here manifests as an expensive, silent
claim/release ping-pong rather than a loud error.
