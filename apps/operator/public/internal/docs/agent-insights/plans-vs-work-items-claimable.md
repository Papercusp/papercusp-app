# Plans vs work-items — how a plan item becomes claimable, and which surface a coordinator pushes work onto
URL: /internal/docs/agent-insights/plans-vs-work-items-claimable

A plan item (P-NNN) is authoring/intent; a work-item (WI-/F-NNN) is the claimable execution unit. The two bridges (plans:start promotion + plan_items:convert at pickup), how the lane is claimed, and what a coordinator/Mug actually pushes work onto.

## The two surfaces

* **Plans (`plans:*`)** — the PG-canonical authoring + intent layer. A plan has items `P-NNN`
  (each with an `effectiveStatus`: todo / wip / blocked / needs-human / done / dropped),
  decisions, a `## Now` anchor, and per-item **claim leases** (the "lane"). This is where a
  human/su/Mug decides *what should happen* and in what order.
* **Work-items (`work_items:*`)** — the claimable **execution** queue: `WI-NNN` (task/bug/change)
  and `F-NNN` (feature). `claim_next` / the Mug's placement offer `todo` work-items to agents.
  This is where work is *picked up and done*.

A plan item is **not** directly claimable. It becomes claimable only as a work-item, via one of
two bridges.

## Bridge 1 — `plans:start` promotion (the bulk path)

`plans:start` (the same verb a human, su, or the Mug calls) auto-promotes every **OPEN**
plan-item into a placeable, **UNCLAIMED** work-item (`plan-workitem-promotion.ts`,
`computePromotions`). The work-item is `kind:'feature'`, carries `source_plan_item_ids` (the
idempotency key with the slug, so re-starting never double-mints), and lands in the queue for the
Mug/self-selection to place. Gated by `papercusp-plan-workitem-promotion`. This is why "I
started a plan but the Mug sat idle" was a bug — without promotion a started plan minted zero
work-items.

## Bridge 2 — `plan_items:convert` (convert-at-pickup, the pickup verb)

`plan_items:convert` is **THE pickup verb**: it takes the policy-checked plan-item lease, mints
(or resumes) the work\_item execution record **with the caller as assignee** (default `kind:'task'`),
links it back to the plan item (an `implements` edge + a `payload.plan_item` stamp), and flips the
plan item `todo→wip` + broadcasts the claim (via `emits:`). The work-item's later lifecycle
**reflects back** onto the plan item (`plan-items/reflect-rules.ts`, read straight off the
`payload.plan_item` stamp) — not a flat `complete→done`. The current mapping:

* `work_items:complete` **or** a `set_state` into a **terminal** state → `done` (from
  `passed` / `resolved` / `done`) **or** `dropped` (from `deprecated` / `closed` / `dropped`). A
  completion that *closes*/defers the item reflects `dropped`, **not** `done` (EI-8353); a
  completion that leaves the work-item non-terminal does **not** flip the plan item at all.
* `set_state todo|open` → `todo` (reopened); `work_items:release` of a still-non-terminal item →
  `todo` (back to the pool).
* Finishing (`complete`) **or** `release` also **drops the plan-item lease** (`plan_items:release`),
  so the lane frees immediately instead of dangling until its TTL.

So "working a plan item" = convert it first — there is no untracked self-item.

**Bulk API (bulk-endpoint-standardization-2026-06-21).** You can convert several items in one call:

```
plan_items:convert { plan, item }                                    // single
plan_items:convert { plan, itemIds:['P-001','P-002'], brief }        // many in same plan
plan_items:convert { items:[{ plan, item }, { plan, item, kind }] }  // heterogeneous
```

Returns `{ ok, results:[{ ok, plan, item, status, workItem?, planItem? }], counts }`. A
refused/conflicted convert is that item's `ok:false` without failing the rest.

**`plan_items:assign` is also bulk.** Same three shapes (`{ plan, item }` / `{ plan, itemIds:[…] }` /
`{ items:[…] }`), returns the same `{ ok, results, counts }` envelope.

## Claiming the LANE (declaration, not execution)

Distinct from minting a work-item, a coordinator/agent declares the **lane** it owns on the plan:

* `coord:declare-intent { current_plan_slug, items:['P-001',…] }` — claims those items' leases
  (auto-releases ones moved off). `coord:orient { planSlug, planItems }` does the same on wake.
* `plans:set-status P-001 wip` — auto-claims that item; `done`/`dropped` releases it.
* `plan_items:claim` — the live grip; `plan_items:assign` — **push** an item to ANOTHER named
  agent (intra-user; the target reads it via `plan_items:my_items`).

A `claim_conflict` means a live peer holds the lease — coordinate, don't take it.

## What a coordinator/Mug actually pushes work onto

* **Hand a specific plan lane to a peer + get it picked up NOW** → `coord:dispatch { to, planSlug, items, note, harness? }` — it `plan_items:assign`s the lane (durable) AND wakes + confirms
  (see [coordinator-dispatch-and-wake](/internal/docs/agent-insights/coordinator-dispatch-and-wake)).
  Pass `harness` when the plan lives in a non-default harness; it threads through to the assign.
* **Hand a lane durably without a wake** → `plan_items:assign` (the target pulls it on its next turn).
* **Feed the open claimable queue** → `plans:start` (bulk promotion) or `work_items:create` directly.
* **The Mug** places ranked *work-items* onto cups (it does not hand out raw plan items) — the
  pot scheduler's `get_next` offers a cup a floor-AND-spec-compliant work-item.

Rule of thumb: **author + sequence on the plan (P-NNN); claim + execute on the work-item
(WI-/F-NNN).** A coordinator pushing plan work to a peer uses `coord:dispatch` / `plan_items:assign`;
a coordinator feeding the open pool uses `plans:start` / `work_items:create`.
