/**
 * Client-safe constant export for the default workspace id.
 *
 * Why this file exists: `workspace-registry.ts` imports `node:fs` at module
 * scope to do registry I/O. Pulling any export from there — even a string
 * constant — drags `node:fs` into the consumer's chunk. Turbopack's app-
 * client chunking context refuses external modules → build fails.
 *
 * Extracted so client modules (e.g. `use-workspace-id.ts`) can import the
 * constant without triggering the cascade. `workspace-registry.ts` re-
 * exports for backward compat.
 *
 * ⚠️ NOT a safe fallback for a SERVER-SIDE sweep/watchdog/background scope
 * (EI-18660454282479136 — the "silently scoped to the wrong/empty workspace"
 * class, seen at least 4 times: WI-5791, EI-10103, plans/revisions.ts,
 * host-bootstrap.ts's old stall-waker). `opts.workspaceId ?? DEFAULT_WORKSPACE_ID`
 * reads like a safe default but on a multi-workspace install is a silent SCOPE
 * ERROR: `'default'` is a near-empty scratch bucket, every real pot lives
 * elsewhere, and the sweep returns a success-shaped zero-coverage result —
 * indistinguishable from "checked everything, all healthy". This constant is
 * only for a genuinely CLIENT-side / single-tenant-request context (a browser
 * tab with no workspace header yet, a UI default). A background job deciding
 * WHICH workspaces it must cover should call `backgroundWorkspaceIds()`
 * (workspace-registry.ts — the canonical policy already shared by the DBOS
 * dispatcher, the await-event sweeper, and the pot wake-rule boot
 * registration), or REQUIRE the scope and fail loud (see
 * `agent-insights/scoped-sweepers-must-enumerate-not-default`). Enforced by
 * `scripts/check-scope-defaults.mjs` (D-003) for the `?? DEFAULT_WORKSPACE_ID`
 * shape — but that lint is regex-based and cannot catch every shape (e.g. a
 * loop that silently binds only to `registry[0]`), so read the insight doc
 * before writing a NEW background sweeper, don't rely on the lint alone.
 */
export const DEFAULT_WORKSPACE_ID = 'default';
