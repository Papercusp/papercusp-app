# RESTORE — legacy `apps/web` Next.js web admin

Retired 2026-06-10 (full-app audit P-079, `papercusp-full-app-audit-2026-06-09`).

This was the original standalone Next.js web admin (`next dev -p 3055`) for the
harness: issues grid, terminal, git graph, BlockNote docs. It is fully
superseded by the operator UI (`apps/operator` + operator-vite SPA inside the
Tauri desktop shell) and was the last live importer of the retired Zero stack
(`@rocicorp/zero/react` + `@papercusp/zero-harness` in
`app/harness/issues/IssuesList.tsx`).

Why retired rather than migrated: the standalone webapp deployment model itself
is retired (see superproject `CLAUDE.md` → deployment model); migrating its data
layer to `@papercusp/sync` would modernize an app nothing launches.

## Restore

1. `git mv _retired/apps-web apps/web` (back inside the `apps/*` workspace glob).
2. `npm install` at the submodule root to re-link workspace deps.
3. Migrate `app/harness/issues/IssuesList.tsx` off Zero to `@papercusp/sync`
   (`useSyncQuery`) — Zero stays retired regardless.
4. Re-add the "Web admin (apps/web)" deployment row to `DEPLOYMENT.md`.

Restore point: the move commit landed via git-sync on `staging`, 2026-06-10.
