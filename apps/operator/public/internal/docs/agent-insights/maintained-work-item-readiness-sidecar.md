# Maintained work-item readiness — a local sidecar, NOT a column (work_items federates)
URL: /internal/docs/agent-insights/maintained-work-item-readiness-sidecar

Why scheduler readiness is materialized as a local non-federated blocked-set table (work_item_blocked) maintained by triggers, instead of a `ready` column on the unified work_items table — and how the flagged claim cutover + reconciliation oracle work.

## TL;DR

Scheduler **readiness** (is a work-item claimable — every `blocked_by` edge satisfied?) was being
recomputed **inline per claim** (a correlated `NOT EXISTS` over `work_item_deps` + blocker statuses in
`claimFloorsWhereSql`). To make it an **indexed** read, it's now materialized — but **NOT as a `ready`
column on `work_items`**. It lives in a separate **local, non-federated** table
`harness_shared.work_item_blocked` (**presence of a row = NOT ready**; absence = ready), maintained by
triggers. The claim switches to an indexed anti-join behind a flag.

## The non-obvious part: why a sidecar, not a column

The obvious design (the plan's original P-005 text) is "a maintained `ready` boolean column on the
work-item." **That is wrong here, because `work_items` is federated.** Two live triggers make a plain
column unsafe:

* `stamp_local_federated_write_trg` (BEFORE UPDATE) bumps `fed_ts` on **any** write.
* `capture_work_items_feature_upd_trg` (AFTER UPDATE) fires on a **whole-row diff**
  (`old.* IS DISTINCT FROM new.*`) and captures the row to the federation outbox.

So a `ready`-flip would **federate** the row. Readiness is a value each node must **derive locally** from
the (already-federated) edges + statuses — replicating the derived value invites a stale federated
`ready` to overwrite a node's local recompute → **a cup claims blocked work**. (Decision D-007 in
`work-item-deps-and-readiness-2026-06-22`.)

The sidecar sidesteps all of it: the maintenance triggers write **only** `work_item_blocked`, never
`work_items`, so none of the federation/churn/stamp triggers fire from readiness maintenance.

## Schema reality you must know first

The P-010 work-item unification has **physically landed**: `harness_features_consolidated` and
`engineer_issues` are **auto-updatable VIEWS** over the unified base table `harness_shared.work_items`
(features = `item_kind NOT IN ('bug','change','task')`; issues = the rest; `engineer_issues.state` **is**
`work_items.status`). So one `status` column + one terminal set `{passed,deprecated,resolved,closed}`
cover both families, and a write via either view fires the triggers on `work_items`. Verify with
`SELECT relkind FROM pg_class …` before assuming these are tables.

## How it's maintained (migration 379)

* `work_item_is_blocked(harness, feature)` — the **oracle**, a byte-for-byte mirror of
  `claimFloorsWhereSql`'s inline predicate (feature blocker non-terminal via `harness#id`; issue blocker
  non-terminal via bare id in ws `'default'`).
* One-hop triggers (all **exception-guarded** — a readiness-sync error must never wedge the underlying
  work-item write; drift is caught by the oracle + sweep):
  * `wir_deps_sync` on `work_item_deps` → re-sync the blocked feature.
  * `wir_status_sync_dependents` on `work_items` AFTER UPDATE OF status, gated to the **terminal-boundary
    crossing** → re-sync the items this row blocks (O(in-degree)).
  * `wir_insert_sync_own` / `wir_delete_cleanup` for lifecycle.

## The claim cutover (flag)

`SCHEDULER_MAINTAINED_READY` (now **default ON** — graduated 2026-06-22 after a sustained live drift=0
verify + the flag-ON claim path green end-to-end). `claimFloorsWhereSql` reads `NOT EXISTS
(work_item_blocked …)` (indexed) when on, the inline `NOT EXISTS` when off. **Both** claim entry points —
`claimNextWorkItem` and `getNextWorkItem` — resolve `schedulerMaintainedReadyEnabled()` (fail-CLOSED to
the inline predicate) and pass the boolean into the shared fragment, so the two paths can never drift
(D-002). OFF is the reversible kill-switch back to the byte-identical inline predicate.

**Before changing the default or trusting the sidecar on a new DB, verify zero drift.** Run
`reconcileReadiness()` (or the inline SQL: `EXCEPT` both ways between `work_item_blocked` and the
`work_item_is_blocked()` set over features) — `drift = missing + extra` must be 0. `missing`
(oracle-blocked but no sidecar row) is the dangerous one: a blocked item looks ready → a cup claims
blocked work. The claim test pins both arms explicitly (an inline-OFF describe + a sidecar-ON describe)
so a fragment bug in either path is caught.

## `claimFloorsWhereSql` grew sibling floors — don't mistake them for readiness (2026-07-03)

Two unrelated hardening changes landed inside the SAME `claimFloorsWhereSql` fragment this doc
describes. Neither touches readiness/`work_item_blocked` semantics — call them out so a reader
diffing the function doesn't assume they did:

* **Release-cooldown floor** (`fleet-scheduler-hardening-2026-07-03` P-005 / EI-6956, migration
  `485`): a `cooldownAssignee` opt adds a `last_released_by`/`last_released_at` NULL-safe clause
  that excludes a row from claiming **only for the agent that just voluntarily released it**,
  for `PAPERCUSP_RELEASE_COOLDOWN_SEC` (default 300s) — kills the claim/release ping-pong where a
  released row resets to `todo`, re-sorts to the top under a stable rank, and the same cup
  re-claims it immediately. `releaseWorkItem` stamps the provenance; every other agent can still
  claim the row instantly. This is a **fairness/anti-thrash** floor, not a correctness-of-readiness
  one — a cooled-down row is still fully "ready" by the oracle's definition, just temporarily
  off-limits to one claimant.
* **`CLAIM_STATES_ALLOWLIST`** (`['todo', 'open', 'failing']`, WI-1912): closes the exact same
  *floor-widening* class this doc's D-002 already fixed for the readiness predicate, but on the
  sibling caller-supplied `states` arg (`scheduler:get_next` / `work_items:claim_next`) — a fleet
  member had passed `states:['todo','open','blocked']` and pulled a leader-triage-only item. Same
  principle as this doc's core claim (a caller must never widen past a floor state), applied one
  layer up from `claimFloorsWhereSql` itself.

Several more exclusions now sit ANDed alongside `claimFloorsWhereSql` (and its issue-family sibling
`claimNextIssueWorkItem`) at the claim entry points in `work-items.ts` — same "not readiness, a
separate floor" caveat applies:
`reservedPlanLaneExclusionSql` (WI-2118, keeps a plan-reserved lane out of the general claim pool),
`crossMachineRigExclusionSql` (WI-2796, excludes items pinned to an unavailable cross-machine rig),
`claimHoldExclusionSql` (WI-2797, `payload._claimHold:true` — a leader's ad-hoc "don't re-serve
this" hold on a specific item, `COALESCE(wi.payload, '{}'::jsonb) ->> '_claimHold' IS DISTINCT FROM
'true'`), `observationLaneExclusionSql` (D-005, a `lane:'observation'` scorecard/reflection row is
never work-queue material), `needsHumanExclusionSql` (EI-7776, an issue-family row
`improvements:resolve` already routed to a human — the issue dialect has no real terminal
"needs-human" state, so without this a drain-loop cup re-claims and re-posts the same routed-to-human
comment forever), and `federationDetectorExclusionSql` (WI-2633, gates an auto-filed
replication-liveness detector EI to the p2p fleet that can actually action it). None of these touch
`work_item_blocked` / oracle readiness — an item can be fully "ready" and still correctly excluded
here for an orthogonal reason. Every one of the exclusions above is still directly claimable **by
id**; only opportunistic self-select (`claim_next` / `scheduler:get_next`) skips them.

**Migration 499** extended the release-cooldown floor (mig 485/EI-6956, described above) to the
**issue-family** claim path too: `claimNextIssueWorkItem` now applies the exact same NULL-safe
"released by ME within the cooldown window" exclusion the feature-family floor already had, closing
the same claim/release ping-pong (confirmed live, WI-652/WI-2381-class) for bug/change/task rows.

## Gotchas

* The sidecar key is `(workspace_id, harness_slug, feature_id)` — the feature's **real** workspace, not
  the deps' `'default'` coordination workspace. The triggers resolve the feature row's `workspace_id`
  from `work_items`; the claim anti-join matches on it.
* The sidecar is **feature-family only** — the `wir_*` triggers never track `bug`/`change`/`task` rows,
  so it would (wrongly) report a blocked **issue** as ready. The issue-claim path in `work-items.ts`
  therefore **always** uses the inline `NOT EXISTS` predicate over `work_item_deps`, regardless of the
  `SCHEDULER_MAINTAINED_READY` flag — it's the secondary, lower-volume claim path, so the un-indexed read
  is an accepted cost. Only the feature-claim paths (`claimNextWorkItem`, `getNextWorkItem`) cut over.
* `db:migrate` needs `PAPERCUSP_ALLOW_DB_MIGRATE=1`; without it, validate a migration in a rolled-back
  `BEGIN … ROLLBACK` against the real DB (compiles functions, runs the backfill, lets you check
  reconciliation), then let boot-apply record it — or `psql -f` + INSERT the `schema_migrations` row in
  the same txn (it's `(filename, applied_at, sha256)`).
* A comment containing a backtick inside a `sql\`…\`\` tagged template **terminates the template** — keep
  SQL-fragment comments backtick-free.
