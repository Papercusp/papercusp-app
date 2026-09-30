# Plan promotion vs. stale lane state — diagnose an empty fleet without relaunching
URL: /internal/docs/agent-insights/plan-promotion-vs-stale-lane-resync

How to distinguish delayed/missing plan promotion from an already-promoted work-item stuck in an obsolete blocked lane, and repair it through the canonical staging writer.

## The symptom

A fleet member finishes one plan item, the next item is `todo` with zero blockers, but `scheduler:get_next` reports a drained lane. Do not treat that as one generic promotion failure. Two different states look identical from the member:

1. no work-item exists for the ready plan item; or
2. a work-item already exists, but its stored lane is still `blocked` from an older dependency snapshot.

A third trap is a false monitoring zero: `fleet:leader-brief.claimable_now` can disagree with the actual feature-family claim writer. Never rewrite a claim spec from that count alone.

## Read the writers in this order

1. Read `plans:items { slug, harness }` and `plan_items:status { plan, harness }`. Establish the plan item's stored/effective status and unresolved blockers.
2. List the mapped work-items with `work_items:list { sourcePlanSlug, harness }`, projecting only `id`, `state`, `assignee`, and `payload.plan_item`. This separates missing promotion from stale lane state.
3. Read the specific candidate with `work_items:observe { id, harness }`. Its `available` verdict is the cheapest authoritative discriminator before waking a member.
4. Read `dev:pipeline_position { path: 'packages/operator-core/lib/agent-tools/plans/start.ts' }` before interpreting a `plans:start` response. `:3070` serves deployed green `main`; `:3170` serves staging. A live response can legitimately use older writer semantics while the durable fix is committed on staging.

## Interpret `plans:start` precisely

The current writer awaits `promotePlanItems` and returns `promotion` before responding. `promoted:N` means N new rows were minted. `skipped:N` means open plan items were already covered by linked work-items; it does not mean those rows are claimable. Inspect them. A response from an older deployed writer saying promotion runs asynchronously carries no queue outcome; do not report failure or success from the message alone. Re-read the mapping after the worker has had a bounded interval.

If a tested current writer is committed on staging but not deployed, an idempotent `plans:start` through `ptool --url=http://127.0.0.1:3170` can return the structured outcome against the shared canonical datastore. Do this only after `dev:pipeline_position` proves the path is present on staging, and preserve the singleton release gate rather than launching another checkpoint.

## Repair the stale-lane case

When the plan item is ready but its mapped work-item remains `blocked`, do not flip the work-item state directly, hand-convert the plan item, rewrite the fleet claim spec, or relaunch the fleet. Re-emit the plan item's verified current `blockedBy` value through the canonical writer:

```text
plans:set-item-blocked-by {
  slug: '<plan>',
  item: 'P-NNN',
  blockedBy: <the exact current list>,
  harness: '<harness>',
  rationale: 'Unchanged re-emit to route the linked work-item through resyncPlanItemLaneNow'
}
```

During live/staging skew, invoke that writer through `:3170` only after verifying staging contains the resync implementation. The writer re-reads the current plan graph, clears or applies the typed `plan-lane:<plan>#<item>` blocker, and moves the linked row through the existing lane transition surface.

## Closure evidence

A repair is not proven by `plans:start`, a plan revision, or `work_items:observe` alone. Verify all three:

* the mapped work-item is `open` and `available:true`;
* the existing fleet member was woken successfully (`woken:1`); and
* that same member's `scheduler:get_next` actually claimed the mapped work-item.

If `fleet:leader-brief.claimable_now=0` but `work_items:observe` says available and the unchanged member immediately claims the row, file the false-drain monitor defect. In the 2026-08-20 incident this was reproduced on a plan-filtered feature fleet and filed as EI-21022436208725242.

## Why this procedure is safe

It reuses the two canonical surfaces: `promotePlanItems` for missing nodes and `resyncPlanItemLaneNow` for an existing node's lane. It preserves fleet identity, plan/work-item links, claim-spec history, and the singleton release gate. The regression guard for structured promotion outcomes lives in `plans/__tests__/start-guard.test.ts`; lane transition coverage lives beside `reconcile-linked-work-items.ts`.
