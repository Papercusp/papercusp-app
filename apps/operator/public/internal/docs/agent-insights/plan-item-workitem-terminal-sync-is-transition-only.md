# A done plan-item can leave its work-item stuck in todo — the reconciler is transition-only
URL: /internal/docs/agent-insights/plan-item-workitem-terminal-sync-is-transition-only

When a plan item is done but its linked work-item still shows state:todo, the reverse reconciler is NOT missing — it exists (reconcileLinkedWorkItemsForPlanItem) but only fires on the plan-item's done TRANSITION, so a WI that reaches todo AFTER the item is already done is never re-healed. Don't add a duplicate propagation leg; the fix is the claim-lane guard + a periodic sweep.

## The symptom

A backlog-drain fleet member claims a `todo` feature work-item, discovers its
linked plan item (`payload.plan_item`) is **already `done`**, re-verifies "already
implemented, no code needed", and hand-closes it. Repeat across the fleet for
every such item — pure re-work churn. Filed at least four times as separate bugs
(EI-13337, EI-13352, EI-13267, EI-14693) plus the WI-3485/86/89/93/95 straggler
cluster.

## The tempting-but-WRONG diagnosis

"Plan→work-item completion propagation is MISSING — when a plan item flips done,
nothing terminalizes the linked work-item; add a leg to `setStatusOne`
(plans/set-status.ts)."

**It is not missing.** `reconcileLinkedWorkItemsForPlanItem`
(`plan-items/reconcile-linked-work-items.ts`, EI-5925) already does exactly this:
it finds every WI linked to a just-done plan item — via BOTH truth sources (the
`implements` coord-link edge AND the `payload.plan_item` stamp) — skips
already-terminal and in-flight (`lastProgressAt` set) items, and terminalizes the
rest (feature→`passed`, issue→`resolved`). It is wired as a reaction rule
(`reconcile-rule.ts`) on `plans:set-status` (the "rule sat dead reading the bulk
envelope shape" bug was fixed in EI-6960, 2026-07-09). Adding a `setStatusOne`
leg **duplicates** it. Don't.

## The actual root cause

The reconciler fires only on the plan item's **done TRANSITION**
(`newStatus === 'done' && oldStatus !== 'done'`). A work-item that arrives at
`todo` **after** its plan item is already `done` is never re-reconciled, because
that transition already happened. Three ways a WI lands in that state:

1. **Complete-without-state** (the D-004 / EI-13318/13346/14676 footgun):
   `work_items:complete` does *not* auto-close the WI unless you pass a top-level
   terminal `state`. An agent that flips the plan item done + writes a
   "(← WI-xxxx completed passed)" annotation but omits `state:'passed'` leaves the
   WI in `todo`. This is BY DESIGN (don't step on the reviewer pipeline) — not a
   bug to "fix" by auto-closing.
2. **Reconciler's in-flight skip**: if the WI had `lastProgressAt` set (someone
   worked it), the reconciler deliberately skips it to avoid clobbering parallel
   work — so it stays `todo`.
3. A WI minted/reset into `todo` after the plan item completed.

Note it is usually **not** a reaper "reset": `FEATURE_NON_REQUEUE_STATES`
(`work-item-dispatch-states.ts`) already includes `passed`/`deprecated`, so the
stale-claim / spawn-reclaim reapers leave terminal feature rows alone.

## Where it bites, and the fix

Any surface that reads a WI's raw `state` without checking the linked plan-item's
terminal status re-surfaces the orphan:

* **The claim path** (`getNextForBee` → `planItemLaneBlockReason`,
  `scheduler/plan-item-lane-guard.ts`). This post-claim guard already released +
  retried a claimed WI whose plan item is `blocked`/needs-human; as of 2026-07-17
  it **also** blocks a `done`/`dropped` linked plan item — so the drain fleet stops
  re-working already-done items. (Fixed here.)
  * ⚠ **The gated (`blocked`/needs-human) case has the SAME transition-gap the
    terminal case does — and it is a worse symptom** (EI-14699). The post-claim
    guard *releases* a blocked-lane WI but leaves its `state:'todo'`, so
    `scheduler:get_next` re-serves it every cycle: a perpetual claim/release
    **ping-pong** (WI-3475/WI-3467 each cycled 8+ times). The durable fix is the
    same as the terminal one — **heal the data at the source, in the periodic
    orphan-reconcile sweep** (`reconcileOrphanedPlanItemWorkItems`), not another
    consumer guard: the sweep now PARKS a blocked/needs-human lane's linked WIs out
    of self-select and UN-parks them when the lane is actionable again
    (`syncLinkedWorkItemsToPlanLane` / `decideLaneGate`). Parking reuses the
    external-blocker machinery (`work_items:set_blocker`) — a provenance-carrying
    `plan-lane:<plan>#<item>` blocker is the marker that the sync (not something
    else) parked the item, so un-park never clobbers an independently-blocked WI.
    Don't add a duplicate propagation leg to `setStatusOne`; extend the sweep.
* **`pot:survey` placement frontier** (`pot/survey.ts`) still ranks a done-plan-item
  `todo` WI as "unplaced/aging" → spurious Mug placement wakes. (Residual, tracked
  on EI-14693.)

## The durable fix (if you're here to finish it)

Guarding each consumer is belt-and-suspenders. The real fix is to **heal the
data**: a periodic, idempotent, non-transition-gated sweep that terminalizes any
`todo` WI whose linked plan item is already terminal — i.e.
`reconcileLinkedWorkItemsForPlanItem` run on a schedule (a `tier:ephemeral`
blueprint schedule or a DBOS scheduled workflow — never a bare `setInterval`),
extended to also handle `dropped` (it is currently done-only: it bails unless the
plan item's `current.status === 'done'` and maps only to `passed`/`resolved`). That
corrects every downstream surface at once. Tracked on EI-14693.

## How to spot orphans in the wild

```sql
-- todo feature WIs whose linked plan item is already terminal
WITH todo_wi AS (
  SELECT f.feature_id, f.payload->'plan_item'->>'plan_slug' AS ps,
         f.payload->'plan_item'->>'item_id' AS pit
    FROM harness_shared.harness_features_consolidated f
   WHERE f.status='todo' AND f.origin='local' AND f.payload ? 'plan_item'
)
SELECT t.feature_id, t.ps, t.pit, itm->>'storedStatus' AS plan_item_status
  FROM todo_wi t
  JOIN harness_shared.harness_plans p ON p.plan_slug = t.ps
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.items,'[]'::jsonb)) itm
 WHERE itm->>'id' = t.pit
   AND COALESCE(itm->>'storedStatus', itm->>'status') IN ('done','dropped');
```
