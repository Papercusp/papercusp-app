# A migration+code-flip "lockstep" is NOT atomic when two operators share one DB
URL: /internal/docs/agent-insights/lockstep-migration-not-atomic-across-shared-db-operators

WI-148 moved papercup data 'default'→'papercusp-workspace' in lockstep with a resolver code-flip, "atomic on the :3070 deploy". But :3170 (staging) shares :5432/papercusp with :3070, so :3170's boot applied the migration to the shared DB AHEAD of the :3070 flip → a transient move-without-flip window where :3070 read empty. Plus the deploy health-probe never does a consumer read, so auto-rollback can't catch it.

## What

WI-148 reconciled papercup's workspace identity: a DATA migration (295) moving
every papercup row from `workspace_id='default'` → `'papercusp-workspace'`, in
**lockstep** with a resolver code-flip (`plans/source.ts` `isPapercupScope →
PAPERCUSP_WORKSPACE_ID`). The design called it "atomic on the :3070 deploy"
(migrations-before-serve: boot applies 295 → restart with the flip → consistent).

It was **not** atomic. For a window, the live `:5432/papercusp` DB had the data
already moved (445 plans in `papercusp-workspace`, 0 in `default`, 295 in
`schema_migrations`) while `:3070` still ran the **pre-flip** code (release
`c15587c0`, resolver → `'default'`). So `:3070`'s papercup plan reads queried
`'default'` → **0 rows → effectively 404** — the exact "move-without-flip" half
the migration was written to avoid.

## Why

Migrations auto-apply on **any** operator boot, and on the dev box **`:3170`
(staging) and `:3070` (release) share the same `:5432/papercusp` DB**. The
lockstep's atomicity assumed a single operator boots the migration and flips its
own code in one restart. But `:3170` booted the staging tree (which already
pinned 295) and its migration-runner applied 295 to the **shared** DB — ahead of,
and decoupled from, the `:3070` code-flip deploy. Whichever operator boots the
new tree first moves the data for **both**; the other keeps serving the old
resolver against moved data until *it* redeploys.

It self-healed: once the `:3070` deploy restarted it onto the flip (`9c78a5512`,
05:27:38), code + data agreed and reads returned 200. The window was minutes, not
hours — but on a busier surface it would have been a live incident.

## The compounding gap — the deploy gate can't see it

The post-deploy gate does **not** prove the consumer path works:
`health-probe.ts` probes `/api/health` + `POST /api/mcp initialize` (now with
the strict MCP `Accept: application/json, text/event-stream` header);
`verify-release-paths.ts` checks runtime file reads resolve under the release
root, with a special prompt-decoupling policy when a prompt-root override is
active. **Neither does a papercup plan read.** So a deploy that lands a half-state
(move-without-flip *or* flip-without-move) **passes the gate and does not
auto-rollback**. The migration header's "papercup-read health-check → rollback"
was aspirational, not implemented.

## The submodule-gitlink trap — it bit twice

The migration that mattered (295) lives **inside the `libs/papercusp`
submodule** (`libs/papercusp@22809c7213:libs/db/sql/295-...`). The release
tooling computes its migration list with `migrationsBetween()`, a **superproject
git diff** — which only ever sees the `libs/papercusp` **gitlink move**, never
the migration FILES inside the submodule. That one blind spot bit twice in one
incident:

1. **It disabled the DB rollback.** The deploy plan showed `migrations: []`, and
   `deploy.ts:~328` gates `rollback-db` (restoreSnapshot) on
   `plan.migrations.length > 0`. So even though `applyStagedMigrations` *does*
   apply 295 (it scans the sql dir on disk, not the plan list), the deploy
   believed there were no migrations → on a health-fail it would have reverted
   **code only**, never the DB. (Harmless here only because the DB was already
   moved and we wanted it moved.)
2. **It tripped a false "flip-without-move" alarm.** A peer checked
   `git cat-file origin/staging:libs/papercusp/libs/db/sql/295-...` — i.e. a
   submodule path through the **superproject** ref — which *always* reports
   "absent" for a gitlinked path, and raised a HARD-STOP that 295 was missing.
   It wasn't: the correct check is against the **pinned submodule SHA**
   (`git -C libs/papercusp cat-file -e <pinned-sha>:libs/db/sql/295-...`, or
   `git cat-file -e <pinned-sha>:...` after resolving the gitlink). Cost \~30 min
   of false-alarm churn.

**Lesson:** for a submodule-hosted migration the deploy's entire
migration-awareness — plan display, risk-tier, AND `rollback-db` gating — is
**blind**. Don't trust `plan.migrations` for rollback decisions when a submodule
moved, and always verify a submodule file against the **pinned submodule
commit**, never the superproject ref. The systemic fix (behind the
papercup-read backstop) is to make `migrationsBetween()` submodule-aware so the
plan, risk-tier, and rollback gate all see submodule migrations. Tracked in
**EI-856**.

## How to apply

* **A lockstep migration+code-flip is only atomic if every operator that shares
  the DB flips its code in the same beat.** If staging and release share a DB,
  expect the migration to leak to the shared DB the moment *either* boots the new
  tree. Plan for it: prefer a **backward-compatible migration** (old resolver
  still returns rows post-migration — dual-write/dual-read, a compatibility view,
  or a transition where both workspace ids resolve) over a hard cutover; or
  deploy the flip to **all** shared-DB operators together; or sequence so the
  flip lands first.
* **On a move-without-flip half-state, do NOT restore the DB** — the data is
  correctly moved; un-moving it re-creates the original empty-frontier bug. The
  fix is forward: land the code flip. (Inverse of the flip-without-move case,
  where reverting the code *is* the safe recovery.)
* **Verify the consumer read yourself; don't trust "health passed".** The gate's
  green is `/api/health` + MCP-init, not a domain read. Prove the flip with a
  read that can only succeed post-cutover — e.g. `plans:get` on a plan that now
  lives *only* in the new workspace (old resolver would 404 it). `plans:*` are
  PG-resolver-backed (`harness_plans` via `resolvePlanScope`; the FS path is
  retired), and current `resolvePlanScope` maps the operator-home scope to
  `PAPERCUSP_WORKSPACE_ID` and concrete member harnesses to their Pot home, so
  a real `plans:get` exercises the live resolver and Pot-scoped plan key.
* **Worth fixing:** add a real papercup-plan-read probe to the deploy health gate
  so a half-state triggers the existing rollback path. Filed via
  `improvements:capture`.

Related: \[\[boot-wire-drain-ordering]]; plans `release-gate-ready-branch-2026-06-04`,
`staging-branch-pipeline-2026-06-06`.
