# 12. Reference runtime walkthrough
URL: /internal/docs/spec/reference-runtime



import { Aside } from '@astrojs/starlight/components';

Several paths in the original table moved. The live operator now lives in
`packages/operator-core` (served via the Hono host on `:3070` + the Vite
SPA `@papercusp/operator-vite` on `:3055`; the standalone Next webapp is
retired). The plugin SDK/loader are `@papercusp/plugin-sdk` /
`@papercusp/plugin-loader`. The `marketplace-api`/`marketplace-site` apps
were removed (distribution is now the Cupboard, `apps/operator-public`),
and the `apps/papercup` reference install is retired to `_retired/papercup/`.

PathContains

`libs/papercusp/packages/harness`The substrate: blueprint prompts (`blueprints/*/prompts/`), role/identity templates (`identity/`), and `bin/` scripts (e.g. `bin/supervisor.sh`). Iterations boot from the per-blueprint DBOS/director pipeline — the standalone `run.sh` run-loop is retired.
`libs/papercusp/packages/harness/blueprints/coding`The POT/Mug blueprint (`id: coding`, `kind: 'pot'`) — the minimal single-role operator that surveys the blackboard and decides its own next wake. The judgment layer over the fleet.
`libs/papercusp/packages/harness/blueprints/coding-factory`The default coding harness (`id: coding-factory`) — a per-feature director driving scoper → architect → worker → validator → reviewer → documenter → curator, with opt-in quality gates (tester / security / crosscheck / ui-qa).
`packages/plugin-sdk` (`@papercusp/plugin-sdk`)TypeScript types for plugin authors. `PapercuspPlugin`, `UiContribution`, `Capability`, etc.
`packages/plugin-loader` (`@papercusp/plugin-loader`)Discovers plugins, validates manifests, applies migrations, registers routines, mounts hooks/tabs/routes, enforces capabilities.
`libs/papercusp/libs/db`Drizzle schema for the substrate (goals, tasks, issues, pending\_events, routines, audit).
`packages/operator-core`The live operator: agent-tools, the `endpoint-route` Hono handlers (the MCP + admin API, e.g. `/api/admin/execute-action`), auth/identity, and harness control. Served by the Hono host on `:3070`; the Vite SPA UI (`@papercusp/operator-vite`) runs on `:3055`. (Supersedes the old `libs/papercusp/apps/web` Next.js webapp, which is retired.)
`apps/operator-public` (`@papercusp/cupboard-worker`)The **Cupboard** — the public listing service for shared harnesses, blueprints, snapshots, plugins, and packs. Cloudflare Workers + Hono + D1. Replaces the removed `marketplace-api`/`marketplace-site`. See §11 and `apps/operator-public/README.md`.
`apps/papercusp-publish` (`@papercusp/publish-worker`)Hosted one-click website publishing — Cloudflare Worker (D1 + KV + R2) fronting our CF Pages account. See §16 (Publishing).
`_retired/papercup`Retired reference install — the 5-director autonomous AI company demo (`@papercup/web`, formerly `apps/papercup`). Preserved-not-active.
