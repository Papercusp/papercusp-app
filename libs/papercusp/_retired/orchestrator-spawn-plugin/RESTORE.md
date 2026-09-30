# RESTORE — `@papercupai/orchestrator-spawn` plugin

**Retired:** 2026-06-06 · plan `archive-legacy-orchestrator-deadcode-2026-06-06` (Phase 1, P-007)
**Last-active submodule commit:** `1c77c941d4a0da97a4100c07a2da078ac285a5ff`
**Original location:** `libs/papercusp/plugins/orchestrator-spawn/`

## What this is

A plugin (`index.cjs` / `index.ts` / `papercusp.json` / `README.md`) exposing spawn /
poll / list_active / cancel tools at `POST /api/plugins/orchestrator/spawn`. It was
**never installed** in any plugin loader (plugins load from
`~/.papercusp/global-plugins/<name>/`, not from this source dir), so its projected HTTP
path **404'd**. It is fully superseded by `packages/operator-core/lib/fleet/operator-spawn.ts`
(`spawnAgentInHarness`, durable `harness_shared.spawned_agents` nursery rows). The one
dead client caller (the operator-chat `<spawn>` fetch in
`apps/operator/app/_components/OperatorConversationProvider.tsx`) was removed in the
same plan (Phase 2, P-010 — the server-side `<spawn>` path already routes through
`fleet:spawn`).

## To restore

```bash
cd libs/papercusp
git mv _retired/orchestrator-spawn-plugin plugins/orchestrator-spawn
```
Then install it into a plugin loader if you actually want it live (you almost
certainly do not — use `fleet:spawn`).
