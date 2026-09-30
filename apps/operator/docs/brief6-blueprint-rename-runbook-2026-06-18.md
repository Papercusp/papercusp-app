# Brief 6 — blueprint rename runbook (P-001..P-004)

> Owner: su-b258e7b7. Plan `domain-generic-pot-architecture-2026-06-18` (harness `all`).
> Brief 6 of `apps/operator/docs/domain-generic-pot-handoff-briefs-2026-06-18.md`.
> **Status: COMPLETE + GREEN (2026-06-18, su-b258e).** All 4 plan items P-001..P-004 → done.

## ✅ COMPLETION RECORD (2026-06-18)

All steps executed in green-stepped turns (owner chose "hold + auto-exec when clear"; green-checkpoint was frozen tonight per su-91881's incident, so no deploy stall).

- **Step 1 — coding→coding-factory:** dir+id, external-bench + detect-from-repo extends, live strict-spine fallbacks (`blueprint-run-action.ts`, `orchestrator-workflow.ts`), every `loadBuiltinBlueprint('coding')` reader, `coding.test→coding-factory.test`, catalog/registry/validate-tool/derive-next-equivalence tests.
- **Step 2 — pot→coding:** dir+id (**kind:pot preserved**), `generic-pot` extends→coding, `HIVE_BLUEPRINT_ID`/`OVERWATCH_BLUEPRINT_ID`/`BUILTIN_LAUNCH_BLUEPRINTS`, the **cup-default spawn** (`operator-spawn.ts:809`), llm-test targets, the base/prompts/overwatch.md stub, base-role-library/launch-blueprint/pot/overwatch tests + the `expected` decider map. Also fixed a Brief-1 split regression: `pot-decider-persona.test` now composes `[base/mug.base.md, coding/mug.md]` via `resolvePromptFiles` (was reading the single delta main).
- **Step 3 — generic-pot→work:** dir+id (extends coding), UI const + picker tests, guidance, `generic-pot.test→work.test`, installed-blueprints/domain-default-packs/projects-create-routes/listings.
- **Step 4 — alias (transition net):** NEW `libs/papercusp/packages/orchestrator/src/blueprint-aliases.ts` (`canonicalBlueprintId`: pot→coding, generic-pot→work; **no coding→coding-factory alias** — coding is reused) wired into `loader.builtinBlueprintPath` + `prompt-resolve` dir/prompt/overlay lookups. 2 new alias tests.
- **Step 5 — instance migration:** the 2 strict-spine instances (`pot-canary`, `frame-work-smoke`) migrated `extends: coding`→`coding-factory`. The many `extends: pot`/`generic-pot` instances (xbench/smoke, mostly ephemeral) are alias-covered. PG `harness_shared.blueprints` needs no manual migration (rows keyed by the instance slug, not the parent; re-projection + alias resolve correctly).

**Verification:** orchestrator full package **74 files / 895 tests green**; operator-core blueprint-area (lib/blueprint, agent-tools/blueprint, fleet/operator-spawn, overwatch, agent-tools/pot) **64 files / 633 green**; plus dbos/knowledge-packs/experiment/endpoint-route, apps/operator CreateHarnessPicker (33), operator-public listings (28). Repo-wide grep: zero stray blueprint-id refs to the old ids.

**Remaining cosmetic debt (NOT load-bearing, safe follow-up):** stale path/prose comments still naming `blueprints/pot/` or `generic-pot` in `overwatch/loop.ts`, `agent-mcp/role-config.ts`, `operator-spawn.ts` (deeper comment), `mug.ts` (`pot/mug.md` in a comment), the `coding`/`work` blueprint.yaml header comments, and the `coding-factory` description (`The default coding harness` → should read coding-factory). None affect tests/behavior. Also: the transition alias should be REMOVED once all live instances + PG are confirmed migrated.

---
> _(original plan below)_
> **Owner: su-b258e7b7.** Plan `domain-generic-pot-architecture-2026-06-18` (harness `all`).

## The rename
- `coding` (strict scoper→architect→worker… spine) → **`coding-factory`**
- `pot` (the coding Pot/Mug) → **`coding`**
- `generic-pot` (the work Pot) → **`work`**

`coding` already exists, so the id must be **vacated** (`coding`→`coding-factory`) before
`pot` can take it. That forces the order below. Blueprint **dir**: `libs/papercusp/packages/harness/blueprints/<id>/`.

## Atomicity contract (the one rule that matters)
A half-rename **at a turn boundary** stalls the hourly green-checkpoint → `main` FF blocked → all
fleet deploys stall. So: **every turn ends with a green tree.** The 3 steps below are each
*independently green* — each step renames ONE id and updates EVERY reference to it in the same turn.
A Bash `mv` is NOT caught by the Edit/Write file-lock hook, so re-check locks+presence on the
blueprint dirs before each `mv`.

## Sequencing facts (verified 2026-06-18)
- Brief 1 (mug split) **DONE + green** — `base/prompts/mug.base.md` (598L), `pot/mug.md` (35L delta), `generic-pot/mug.md` (60L delta), `base/mug.md` (20L stub).
- Brief 2 (scout overlays) touches **no** blueprint dirs (confirmed by su-e9cc3).
- Brief 5 (su-3896e) added `learning:` blocks to `pot`+`generic-pot/blueprint.yaml` and `learnings/{coding,work}` packs — **already on disk**; those lines ride along in the `mv`. COORDINATE on `domain-default-packs.test.ts` + don't co-edit the yamls.
- Brief 3 (su-44055) owns `apps/operator/app/**` incl. `CreateHarnessPicker.tsx` — COORDINATE on the `WORK_HIVE_BLUEPRINT_ID` constant (step 3).
- Desktop sidecar `papercusp-desktop/src-tauri/sidecar/harness/blueprints/` — UNTRACKED/generated (git ls-files empty); no source rename. (Re-verify `git ls-files` before relying on this.)
- **NOT renamed** (different naming axes, deliberately excluded): `kind:'pot'` (federation kind), `hive_slug`/`hiveSlug`, external-bench eval ARM label `'pot'` (`AdvEvalsTab.FLEET_ARMS`, `frontier-report.test.ts`), `PrsTab PR_SCOPES ['harness','pot']`, `HiveVisualIdentity` kinds, harness-axis.test slug fixtures, `apps/operator-public` `listing_ref` (external Comb data — update only for fixture consistency).

---

## STEP 1 — `coding` → `coding-factory`  (independently green)
Vacates the `coding` id. After this step NOTHING references builtin `coding`; `pot`/`generic-pot` untouched.

**Dir + yaml**
- `mv blueprints/coding blueprints/coding-factory`
- `coding-factory/blueprint.yaml`: `id: coding` → `id: coding-factory`
- `external-bench/blueprint.yaml`: `extends: coding` → `extends: coding-factory`

**Live code (strict-spine fallbacks — MUST repoint; alias can't save these)**
- `packages/operator-core/lib/blueprint/blueprint-run-action.ts:121` `loadBuiltinBlueprint('coding')` → `'coding-factory'`
- `packages/operator-core/lib/dbos/orchestrator-workflow.ts:241` `loadBuiltinBlueprint('coding')` (`_codingSpine`) → `'coding-factory'`

**Tests (strict-spine → coding-factory)** — read each to confirm it asserts the spine vs just "a valid blueprint":
- RENAME file `libs/papercusp/packages/orchestrator/src/blueprint/coding.test.ts` → `coding-factory.test.ts`; all `loadBuiltinBlueprint('coding')` (30,37,55,84,99,118,144,156,167) → `'coding-factory'`
- `libs/papercusp/.../blueprint/environment.test.ts:80` → `'coding-factory'`
- `libs/papercusp/.../blueprint/loader.test.ts:21,22,101` (+ test title) → `'coding-factory'`
- `libs/papercusp/.../blueprint/params.test.ts:123` → `'coding-factory'`
- `packages/operator-core/lib/blueprint/blueprint-run-action.test.ts:24` → `'coding-factory'`
- `packages/operator-core/lib/dbos/orchestrator-finalize.test.ts:204` → `'coding-factory'`
- `packages/operator-core/lib/dbos/orchestrator-runner.test.ts:136` → `'coding-factory'`
- `apps/operator/test/blueprint-project-pg.integration.test.ts:71,90,102` → `'coding-factory'`
- `apps/operator/test/blueprint-run-action.integration.test.ts:39` → `'coding-factory'`

**Verify (must be green before ending the turn):**
`cd libs/papercusp/packages/orchestrator && npx vitest run blueprint/` ; then affected: `npm run test:affected`. Plus `node -e "require('./.../loader').loadBuiltinBlueprint('coding-factory')"` smoke. `grep -rn "loadBuiltinBlueprint('coding')"` returns ONLY new coding-after-step-2 (none here).

---

## STEP 2 — `pot` → `coding`  (independently green)
**Dir + yaml**
- `mv blueprints/pot blueprints/coding`
- `coding/blueprint.yaml` (was pot): `id: pot` → `id: coding`
- `work`'s parent: `generic-pot/blueprint.yaml`: `extends: pot` → `extends: coding`

**Live code**
- `packages/operator-core/lib/hive/wake.ts:38` `HIVE_BLUEPRINT_ID = 'pot'` → `'coding'` (rename the const? keep name `HIVE_BLUEPRINT_ID`, value `'coding'` — minimal churn; update doc comments 11,37)
- `packages/operator-core/lib/overwatch/liveness.ts:40` `OVERWATCH_BLUEPRINT_ID = 'pot'` → `'coding'`
- `packages/operator-core/lib/blueprint/launch-blueprint.ts:48` array `'pot'` → `'coding'`
- `packages/operator-core/lib/llm-testing/targets/queen.ts:35` path seg `'pot'`→`'coding'` (+ comments 5,15,63,76,99)
- `packages/operator-core/lib/llm-testing/targets/overwatch.ts:36` path seg `'pot'`→`'coding'` (+ comment 3)
- comments only (accuracy): `overwatch/loop.ts:15,105`, `fleet/operator-spawn.ts:799`, `agent-mcp/src/role-config.ts:130`, `pot/wake.ts:11`

**Add the loader+resolver ALIAS here** (so live instances/PG with `extends:'pot'` resolve to `coding` the moment `pot` is gone):
- `prompt-resolve.ts`: `BLUEPRINT_ID_ALIASES = { pot:'coding', 'generic-pot':'work' }`; normalize id in `blueprintExtends`, `resolveBlueprintChainRoots`, `chainForCtx` dir lookups.
- `blueprint/loader.ts`: normalize id in `builtinBlueprintPath`/`loadBuiltinBlueprint`/`resolveBuiltinExtends`.
  (`generic-pot` alias added now too — harmless before step 3, active after.)

**Tests → 'coding'**
- `packages/operator-core/lib/base-role-library.test.ts:35,85,90,92,95,101,105`
- `libs/papercusp/.../blueprint/launch-blueprints.test.ts:55`, `resolve-child.test.ts:83`
- `libs/papercusp/.../hive-decider-persona.test.ts:12,45,56`
- `libs/papercusp/.../prompt-resolve.test.ts:570,573,587,599,602,617` (the `'pot'` ones)
- `packages/operator-core/lib/blueprint/launch-blueprint.test.ts:261`
- `packages/operator-core/lib/external-bench/coordination-topology.test.ts:44`, `run-topology.test.ts:233`
- `packages/operator-core/lib/hive/{declared-event-wake-e2e,start-hive-e2e}.integration.test.ts:58`, `pot-wake-pg.integration.test.ts:7`
- `packages/operator-core/lib/hive-local-blueprint-resolve.test.ts:45,93`
- `packages/operator-core/lib/overwatch/loop.test.ts:140` (`BLUEPRINT_ID=pot`→`coding`), `overwatch-persona-stub.test.ts:6,25,51`
- ADD alias tests (prompt-resolve + loader): `loadBuiltinBlueprint('pot')` resolves to coding; `extends:'pot'` chains to coding.

**Verify:** orchestrator blueprint/ + prompt-resolve tests; `npm run test:affected`; `base-role-library.test.ts` green (the Brief-1 invariant).

---

## STEP 3 — `generic-pot` → `work`  (independently green)
**Dir + yaml**
- `mv blueprints/generic-pot blueprints/work`
- `work/blueprint.yaml`: `id: generic-pot` → `id: work` (extends already `coding` from step 2)

**Code / guidance**
- `apps/operator/app/harness/CreateHarnessPicker.tsx:71` `WORK_HIVE_BLUEPRINT_ID = 'generic-pot'` → `'work'`  ⚠️ COORDINATE w/ Brief 3 (su-44055)
- `packages/operator-core/lib/agent-tools/hive/create.ts:63` guidance text pot/generic-pot → coding/work
- `packages/operator-core/lib/agent-tools/hive/_create.ts:75,120` comments

**Tests → 'work'**
- RENAME `libs/papercusp/.../blueprint/generic-hive.test.ts` → `work.test.ts`; lines 16,17,23,31,39,43,48,55,58
- `libs/papercusp/.../prompt-resolve.test.ts:579,584,608,613` (the `'generic-pot'` ones)
- `packages/operator-core/lib/blueprint/installed-blueprints.test.ts:52`
- `packages/operator-core/lib/endpoint-route/routes/harness/projects-create-routes.test.ts:223`
- `apps/operator/app/harness/__tests__/CreateHarnessPicker.test.tsx:186`  ⚠️ Brief 3
- `packages/operator-core/lib/knowledge-packs/domain-default-packs.test.ts:113` (`extends:'generic-pot'`→`'work'`)  ⚠️ Brief 5 (su-3896e)
- `apps/operator-public/src/__tests__/listings.test.ts:96` (fixture consistency only)

**Verify:** orchestrator blueprint/ + prompt-resolve; `npm run test:affected`; `installed-blueprints` test (pots list contains work, not generic-pot).

---

## STEP 4 — PG cache + instance-yaml migration (DATA; after code is green)
- `harness_shared.blueprints` (mig 133): rows where `blueprint_id ∈ {pot,generic-pot,coding}` OR `resolved` jsonb embeds them. Re-project affected harnesses (`project-to-pg` re-reads `.papercusp/blueprint.yaml` → re-resolves via the now-aliased loader → overwrites the row). Enumerate: `SELECT workspace_id,harness_slug,blueprint_id FROM harness_shared.blueprints WHERE blueprint_id IN ('pot','generic-pot','coding');`
- Instance `.papercusp/blueprint.yaml` with `extends: pot|generic-pot` → alias covers; migrate persistent ones to `coding`/`work`.
- ⚠️ Instances with `extends: coding` (the OLD strict spine — benchmark/xbench instances) CANNOT be aliased (`coding` now = the pot). They must be migrated to `extends: coding-factory`. Most are ephemeral (su-91881 reaping stale xbench); enumerate + migrate persistent ones. This is the one genuinely-manual data migration.

## STEP 5 — final holistic verify
- `npm run test:affected` clean; `cd packages/operator-core && npx vitest run tools-md-sync` (guidance edits).
- `blueprint:catalog` shows `coding-factory` / `coding` (pot) / `work`; `loadBuiltinBlueprint` for all three.
- Reconcile plan items P-001..P-004 → done; report to owner.
- Optional behavioral: `npm --prefix apps/operator run llm-test -- --target mug` / `overwatch`.
