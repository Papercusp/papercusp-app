# `_retired/` — preserved-not-active code (papercusp submodule)

Code here is **retired but deliberately kept** for reference. It is:

- **not** an npm workspace — it lives outside the submodule's `apps/*` / `packages/*` /
  `libs/*` globs **and** outside the superproject root `package.json`'s explicit
  workspace list, so npm, the affected-test runner, knip, nx, and `tsc` do not treat
  it as live (the structural signal that stops agents mis-reading it as active),
- **not** built, deployed, or tested,
- **not** to be extended or imported by active code.

Do not add features or write tests here. See each subdirectory's `RESTORE.md` for how
to bring a surface back, and the superproject root `CLAUDE.md` →
"Retired / preserved-not-active surfaces" for the full roster + the retire/restore
convention.

## Contents

- `orchestrator-run-loop/` — the legacy `@papercusp/orchestrator` bash-port run-loop:
  the pre-DBOS `runMainLoop` driver + its `pre-loop` / `synthesizer` / `actions-block`
  / `checkpoints(-pg)` / `snapshot-state` / `snapshots-pg` / `mission-state-pg` /
  `dispatches-pg` / `distributed-claim-fetch` cluster, `bin/run.ts`, and the
  legacy-loop dispatcher tests. Retired 2026-06-06
  (`archive-legacy-orchestrator-deadcode`). Restore: `orchestrator-run-loop/RESTORE.md`.
- `orchestrator-spawn-plugin/` — the never-installed `@papercupai/orchestrator-spawn`
  plugin, superseded by `packages/operator-core/lib/fleet/operator-spawn.ts`. Retired
  2026-06-06. Restore: `orchestrator-spawn-plugin/RESTORE.md`.
- `apps-web/` — the legacy standalone Next.js web admin (`apps/web`, `:3055`),
  superseded by the operator UI in the Tauri desktop shell; was the last live
  importer of the retired Zero stack. Retired 2026-06-10 (full-app audit P-079).
  Restore: `apps-web/RESTORE.md`.
