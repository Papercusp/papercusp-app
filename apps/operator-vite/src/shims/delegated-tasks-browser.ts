/**
 * Browser shim for `operator-core/lib/delegated-tasks` (server-only).
 *
 * EI-13213: `commands/defs/delegation.ts`'s `delegates.*` query handlers do
 * `if (typeof window !== 'undefined') { ...fetch...; return; }` before
 * `await import('../../delegated-tasks')` — a RUNTIME guard the browser
 * always takes, so the dynamic import never actually executes client-side.
 * Rolldown can't see that guard at build time though: it still traces the
 * `import()` target statically, and `delegated-tasks.ts` in turn statically
 * imports `work-items.ts`, which fans out (via its own further imports) into
 * `dbos/*`, the substrate `sync/hyperbee/*` layer, and the whole ~550-tool
 * `agent-tools/index.ts` catalog. Because that reachable static edge competes
 * with every OTHER dynamic `import('.../work-items')` call site elsewhere in
 * the server tree, Rollup reports them all as `INEFFECTIVE_DYNAMIC_IMPORT`
 * (their split gets defeated) — and the operator-vite client build ships
 * megabytes of dead server code that no browser code path ever runs.
 *
 * Aliasing this one entry point keeps the whole downstream graph out of the
 * client bundle's module scan entirely, same contract as the other shims in
 * this directory (postgres/dbos/substrate). Real implementation:
 * packages/operator-core/lib/delegated-tasks.ts — untouched; this shim only
 * takes effect inside apps/operator-vite's Vite build (see vite.config.ts's
 * resolve.alias), never in Vitest or the real server runtime.
 */

function serverOnly(): never {
  throw new Error('delegated-tasks is server-only and cannot run in the operator-vite browser bundle');
}

export function listDelegatedSessions(): never {
  return serverOnly();
}
export function getDelegatedSession(): never {
  return serverOnly();
}
export function searchDelegatedSessions(): never {
  return serverOnly();
}
