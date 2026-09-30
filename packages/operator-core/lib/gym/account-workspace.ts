/**
 * WI-5637 — resolve the workspace whose account POOL the gym's LLM egress routes
 * against.
 *
 * Account routing is an OPERATOR-CREDENTIAL concern, NOT a data-isolation one. The
 * account pool (`harness_shared.operator_account_pool`) is WORKSPACE-SCOPED (per-
 * workspace JSONB, migration 190) and lives in the operator's REAL workspace. The
 * gym runs pinned to an ephemeral DATA workspace (`gym-loop-ws`) for harness/schema
 * isolation, and that workspace has NO account-pool row.
 *
 * The first WI-5637 cut passed the gym DATA workspace to `resolveSpawnGatewayEnv`,
 * so its `loadAccountPool('gym-loop-ws')` found zero allowed accounts and threw
 * "account route 'auto' has no allowed claude account in the pool" → the spawn
 * gateway env stayed empty → the curator subprocess got no `ANTHROPIC_AUTH_TOKEN`
 * and auth'd on the local `~/.claude` login → "API Error: Usage credits required
 * for long context" (429). This resolver keeps account routing pointed at the
 * CREDENTIAL workspace instead.
 *
 * Precedence:
 *   1. `GYM_LOOP_ACCOUNT_WORKSPACE` — explicit override (a manual CLI run against a
 *      cold workspace registry, or a cross-workspace pool).
 *   2. `PAPERCUSP_WORKSPACE_ID` — the process pin (a single-workspace operator).
 *   3. `activeWorkspaceId()` — the operator's active workspace, where the pool
 *      lives (e.g. `papercusp-workspace` in the `system:gym-cycle` routine host).
 *
 * Pure + injectable so the precedence is unit-tested without booting a cycle.
 */
export function resolveGymAccountWorkspace(
  env: NodeJS.ProcessEnv,
  activeWorkspaceId: () => string,
): string {
  return (
    env.GYM_LOOP_ACCOUNT_WORKSPACE?.trim() ||
    env.PAPERCUSP_WORKSPACE_ID?.trim() ||
    activeWorkspaceId()
  );
}
