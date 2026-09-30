/**
 * P-062 Phase 4 — pure routing decision for the agent-tools HTTP scoping seam.
 *
 * Given the per-call `ToolScope` and whether workspace-isolation is enabled,
 * decide whether the tool runs on the admin (rolbypassrls) handle or inside a
 * workspace-scoped `withWorkspace(workspaceId)` transaction (harness_app role
 * + RLS). Extracted from catchall.ts's `runScoped` so the decision matrix is
 * deterministically unit-testable without a Postgres connection or an HTTP
 * route — the DB plumbing stays in catchall, the policy lives here.
 *
 * Admin handle is chosen when ANY of:
 *   - isolation is OFF (rollout flag default — behavior-neutral, Phase 3 parity)
 *   - the caller is a superuser (SU shells + the operator) — they intentionally
 *     span workspaces and already bypass RLS
 *   - the tool declares `crossWorkspace: true` (e.g. papercusp:list_workspaces)
 *   - there is no concrete workspace to scope to (missing or the '*' wildcard) —
 *     `withWorkspace` would throw on empty, and a '*' GUC matches no rows
 * Otherwise the tool is isolated to its own workspace.
 */

export type ScopedHandleChoice =
  | { kind: 'admin' }
  | { kind: 'workspace'; workspaceId: string };

export interface ScopedHandleInput {
  /** Auth-derived workspace id; undefined or '*' means "no concrete workspace". */
  workspaceId?: string;
  /** True when admitted via ?superuser=1. */
  isSuperuser: boolean;
  /** The tool being dispatched — its `crossWorkspace` flag opts out of scoping. */
  tool: { crossWorkspace?: boolean };
}

export function chooseScopedHandle(
  scope: ScopedHandleInput,
  opts: { isolationOn: boolean },
): ScopedHandleChoice {
  const ws = scope.workspaceId;
  if (
    !opts.isolationOn ||
    scope.isSuperuser ||
    scope.tool.crossWorkspace === true ||
    !ws ||
    ws === '*'
  ) {
    return { kind: 'admin' };
  }
  return { kind: 'workspace', workspaceId: ws };
}

/**
 * Workspace isolation is ON by default (P-062 Phase 4 flipped default-on after
 * the end-to-end pass: routing 9/9, RLS substrate isolation, full
 * handleHttpToolRequest smoke own=257/foreign=0, every ctx.tx tool a read on a
 * harness_app-grantable table, zero write-via-ctx.tx). `PAPERCUSP_AGENT_TOOLS_WS_ISOLATION='0'`
 * is an operational kill-switch to fall back to the admin handle for every tool
 * if a regression surfaces — set it and restart the host, no code change needed.
 */
export function isWorkspaceIsolationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_AGENT_TOOLS_WS_ISOLATION !== '0';
}
