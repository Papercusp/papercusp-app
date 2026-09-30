# Judging claimable work — status='open' is NOT claimability; query the SSOT
URL: /internal/docs/agent-insights/judging-claimable-work-not-status-open

A raw read of the backlog (SELECT ... WHERE status='open', or reading the needs_human_review column) OVERCOUNTS claimable work by ~13x, because the real claim path applies ~12 unconditional floors that live only in TS sql-fragments. Live: papercusp has ~9.9k issue-family rows at status='open' but only ~740 are genuinely claimable (the rest are observation-lane scorecards, needs-human, claim-held, reserved-plan-lane, blocked, already-completed, ...). Never hand-roll floors: use the dedicated tool work_items:claimable (the authoritative count+rows+excludedBreakdown, wrapping the SAME oracle scheduler:get_next runs). admissibleOnly is only a structural pre-filter, NOT the claimable verdict.

import { Aside } from '@astrojs/starlight/components';

## Symptom

You want to know "how much work is claimable / is the fleet idle?" so you write the
obvious query:

```sql
-- sql-snippet-justified: the WRONG query, quoted as the counter-example this page corrects.
SELECT count(*) FROM harness_shared.work_items
 WHERE item_kind IN ('bug','change','task') AND status = 'open';   -- ⚠ WRONG
```

…and get a number wildly larger than what `scheduler:get_next` / `work_items:claim_next`
will actually serve. A leader then feeds a tranche it believes is claimable, and every
member **refuses** it — an idle fleet sitting on a backlog that *looks* full. This was the
2026-07-12 idle-fleet incident (a 3-item tranche of observation-lane + plan-reserved rows
that `admissibleOnly:true` — a weaker check — still reported claimable while the scheduler
correctly refused all three).

Live scale of the gap (papercusp, 2026-07-20): **9,884** issue-family rows at
`status='open'`, but only **\~744** are genuinely claimable — a **\~13x** overcount. The
other \~93% are mostly observation-lane scorecards (reflections that by design *never enter
the work queue*), plus needs-human, claim-held, reserved-plan-lane, blocked-by-dep,
already-terminally-completed, and federation-detector rows.

Do not read the `needs_human_review` boolean to judge **issue-family** (bug/change/task)
claimability or human-routing — the issue-family signal is `payload.needsHuman`.
`needs_human_review` is the **feature family's** separate human-review flag (set by the
orchestrator on attempts-capped features, cleared by the `approve-human` API, surfaced by
curation/attention). It is a real, live column — currently \~always false only because no
feature is flagged right now — just NOT the issue-family's claimability signal. Don't
conflate the two.

## Root cause

`status='open'` is a *lifecycle* state, not a *claimability* verdict. The claim path
(`claimNextIssueWorkItem` in `work-items.ts`, and the `scheduler/get-next.ts` resolver)
ANDs in **\~12 unconditional per-row floors** that a raw reader never applies. They live
only as TS `sql`-tagged fragments, so there was historically **no SQL object to query** —
every ad-hoc "what's claimable?" read hand-rolled a *different*, weaker predicate that
drifted from what the scheduler serves.

The unconditional (caller-independent) issue-family floors are: not-`open`, taken,
federated-remote, claim-hold (`payload._claimHold`), observation-lane (`payload.lane`),
needs-human (`payload.needsHuman`), active external-blocker, federation-liveness detector
EI, loop-iteration bookkeeping noise, already-terminally-completed
(`terminal_owner`+`terminal_completion_ref` set), reserved-plan-lane (an active plan / live
`plan_item_claims` lease), and blocked-by a present non-terminal `work_item_deps` blocker.

(The scheduler *also* applies **per-claim** floors that depend on the CALLING caller — rig
availability, swarm affinity, redundancy, release-cooldown — which no generic "claimable by
someone" read can bake in.)

## The fix — never hand-roll floors; query the SSOT

Migration **654** (`work-item-claimability-clarity-2026-07-20` P-001) lands the queryable
single source of truth:

```sql
-- The claimable ISSUE-family backlog (fast — a cheap-floor prefilter + the full check):
-- sql-snippet-justified: documents the SSOT view for a human at psql; agents call
-- work_items:claimable, which wraps exactly this so the two cannot drift.
SELECT count(*) FROM harness_shared.work_items_claimable WHERE harness_slug = 'papercusp';

-- WHY is a specific row not claimable? (the violated floor labels; empty = claimable)
SELECT harness_shared.work_item_claim_floors(
  status, taken_by, origin, title, terminal_owner, terminal_completion_ref, payload, feature_id
) FROM harness_shared.work_items WHERE feature_id = 'EI-1234';
-- e.g. => {observation-lane}  or  {needs-human,reserved-plan-lane}
```

For the authoritative in-operator answer, prefer the tools over raw SQL entirely
(`claimable-read-tool-and-sql-encapsulation-audit-2026-07-21` P-001 wraps the view's floors
as a tool so you never touch SQL for this):

* **`work_items:claimable { harness }`** — the dedicated authoritative read: the claimable
  `count` + the actual `rows` + the per-floor `excludedBreakdown`, built on the SAME oracle
  (`aggregateIssueClaimExclusions`) the scheduler's own miss-diagnosis and the fleet
  drain-stamp run. Pass `spec: '<fleet-slug>'` to scope to a fleet's lane, `kind` to
  restrict, `breakdownOnly` for just the counts. **This is the SSOT — reach for it first.**
* **`scheduler:get_next`** — its `excludedBreakdown` is the same oracle if you're already
  claiming; it also reflects the per-claim floors for *your* spec.
* **`fleet:leader-brief`** — the drained/pending verdict already reconciled by the oracle.

`work_items:list { admissibleOnly: true }` is a cheap STRUCTURAL pre-filter (issue-family:
remote-origin + observation-lane exclusion only) — it does **NOT** apply the full claim
floors. It was the *weaker check that CAUSED the 2026-07-12 idle-fleet incident above*
(reporting a tranche claimable that the scheduler correctly refused). Do not treat it as the
claimability answer — use `work_items:claimable`.

`work_items_claimable` / `work_item_claim_floors` are the *reference* definition (correct +
queryable). The scheduler keeps its own efficient inline claim (SKIP LOCKED, sub-ms) — do
NOT route the hot claim path through the per-row function. The two are kept from drifting by
the scheduler↔view agreement test (P-002), not by the hot path calling the view.

## Rule of thumb

> **`status='open'` and `needs_human_review` are NOT claimability.** To judge claimable
> work, call **`work_items:claimable { harness }`** (the dedicated SSOT tool — count + rows +
> `excludedBreakdown`), or `scheduler:get_next`'s `excludedBreakdown` if you're already
> claiming — never a hand-rolled `WHERE status='open'`, and never `admissibleOnly` (a weaker
> structural pre-filter, not the full floors).
