# RESTORE — legacy orchestrator run-loop cluster

**Retired:** 2026-06-06 · plan `archive-legacy-orchestrator-deadcode-2026-06-06` (Phase 1)
**Last-active submodule commit (files in their original location):** `1c77c941d4a0da97a4100c07a2da078ac285a5ff`
**Restore tag:** `legacy-orchestrator-run-loop-retired-2026-06-06` (cut on the submodule, pointing at the pre-retirement commit)

## What this is

The legacy `@papercusp/orchestrator` **bash-port run-loop** — the pre-DBOS iteration
driver (`runMainLoop`) and its private cluster. It was fully superseded by the durable
DBOS pipeline (`packages/operator-core/lib/dbos/orchestrator-workflow.ts` + the
blueprint `deriveNext` engine), which has been the sole, default-on orchestrator since
`dbos-retire-legacy-orchestrator-2026-05-31`. At retirement time every file below had
**0 live importers** (verified by import-grep, 2026-06-06).

## Moved files (all from `libs/papercusp/packages/orchestrator/`)

`src/`: `main-loop.ts` `pre-loop.ts` `synthesizer.ts` `actions-block.ts` `prune-logs.ts`
`snapshot-state.ts` `snapshots-pg.ts` `checkpoints.ts` `checkpoints-pg.ts`
`mission-state-pg.ts` `distributed-claim-fetch.ts` `dispatches-pg.ts` (+ each one's
colocated `*.test.ts`), plus the legacy-loop dispatcher tests
`synthesizer-integration.test.ts` `e2e.dispatcher.test.ts`
`handle-next-validator.dispatcher.test.ts`.
`bin/`: `run.ts` (the `papercusp-orchestrate` entry). Root: `vitest.dispatcher.config.ts`.

`src/` (Phase-3 second sweep): `git.ts`, `branch-iso.ts` (+ `branch-iso.test.ts`) —
they became 0-importer once the cluster above moved (only the cluster imported them).
The live DBOS + chunk-loop worker does its own per-chunk file-lock isolation, not
branch-iso worktrees (`dbos-retire-legacy-orchestrator` D-009/D-012), so branch-iso is
dead under the live path. Their barrel re-exports (`branchIso*` / `worktree*` +
`git` / `branchExists` / `hasStagedChanges`) were pruned from `src/index.ts` too.

Four **superproject-side** integration tests that exercised the moved PG modules were
retired in the same pass to the **superproject** tree at
`_retired/orchestrator-run-loop/apps-operator-test/` (they could not move into the
submodule — different git repo): `snapshots-pg` `checkpoints-pg` `mission-state-pg`
`dispatches-pg` `.integration.test.ts`.

## Surgery that landed WITH the move (must be reverted to restore)

1. **Barrel** `packages/orchestrator/src/index.ts` — removed the dead re-export lines for
   `checkpoints` (`checkpointGate`/`CheckpointAction`), `main-loop`
   (`runMainLoop`/`MainLoopOptions`/`MainLoopExit`), `actions-block`
   (`extractActionsBlock`/`parseActionsJson`/`processActionsBlock` + types), `prune-logs`
   (`pruneLogs`/`PruneResult`), `snapshot-state` (`snapshotState`/`SnapshotResult`),
   `pre-loop` (`runPreLoop`/`PreLoopResult`).
2. **package.json** — removed the 0-consumer subpath exports `./mission-state-pg`,
   `./dispatches-pg`, `./checkpoints-pg`, `./snapshots-pg`; removed the
   `bin.papercusp-orchestrate` entry; dropped the `&& vitest run --config
   vitest.dispatcher.config.ts` tail from `scripts.test` and the `test:dispatcher` script.
3. **`src/cost-cap.ts`** — severed the one live→dead cross-edge: removed the
   `./mission-state-pg` imports + the `evaluateCostCap` **PG overload** and the
   `evaluateCostCapPg` body (the live caller, the DBOS `orchestrator-loop`, only ever
   used the synchronous FS-sentinel path). `evaluateCostCap` is now FS-only.

## To restore

```bash
cd libs/papercusp
# move the cluster back
git mv _retired/orchestrator-run-loop/src/*        packages/orchestrator/src/
git mv _retired/orchestrator-run-loop/bin/run.ts   packages/orchestrator/bin/run.ts
git mv _retired/orchestrator-run-loop/vitest.dispatcher.config.ts packages/orchestrator/
# (superproject) move the 4 integration tests back
cd ..    # repo root
git mv _retired/orchestrator-run-loop/apps-operator-test/*.integration.test.ts apps/operator/test/
```
Then revert the three surgeries above (re-add the barrel re-exports + package.json
subpath exports + `bin` + dispatcher script; re-add the `cost-cap.ts` PG overload +
its `./mission-state-pg` imports). Easiest reference: `git show
1c77c941d4a0da97a4100c07a2da078ac285a5ff:packages/orchestrator/src/index.ts` (and the
same for `package.json` / `src/cost-cap.ts`).
