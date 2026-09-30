/**
 * bench-workspace — the dedicated WORKSPACE benchmark runs live in, isolated from production
 * (plan benchmark-workspace-isolation-2026-06-18).
 *
 * WHY: benchmarks spawn harnesses + agents that exercise the REAL Papercusp substrate — memory
 * (`memory:remember`), coord conversations, work-items, harnesses — ALL of which are WORKSPACE-scoped.
 * Every benchmark launcher used to default its workspace to the PRODUCTION `papercusp-workspace`, so a
 * benchmark agent's memories (e.g. the tau2 `+memory` arm), coord chatter, and work-items polluted the
 * real `papercup` recall + frontier (memory:search fans out within-workspace; the prior ~13k aging-
 * escalation storm came from benchmark work-items in the production frontier). The fix is NOT a new
 * isolation mechanism — workspace isolation already partitions all of these — it is to run benchmarks in
 * a dedicated workspace and NEVER the production one.
 *
 * Every benchmark launcher resolves its workspace through {@link resolveBenchWorkspace}: an explicit env
 * override wins (a per-suite sub-workspace like `bench-swepro` for extra isolation), else the shared
 * {@link BENCH_WORKSPACE}; either way {@link assertBenchWorkspace} refuses the production workspace.
 */

/** The production workspace a benchmark must NEVER write to. */
export const PRODUCTION_WORKSPACE = 'papercusp-workspace';

/** The default dedicated workspace for benchmark runs (isolated from production). */
export const BENCH_WORKSPACE = 'benchmarks';

/**
 * Guard: refuse to run a benchmark in the production workspace. Defense-in-depth — a launcher that
 * forgets to isolate fails LOUD here rather than silently polluting production memory/coord/work-items.
 */
export function assertBenchWorkspace(workspaceId: string): void {
  if (workspaceId === PRODUCTION_WORKSPACE) {
    throw new Error(
      `[bench-workspace] refusing to run a benchmark in the PRODUCTION workspace '${PRODUCTION_WORKSPACE}' — ` +
        `benchmark agents pollute production memory/coord/work-items. Set XBENCH_WORKSPACE_ID (or ` +
        `PAPERCUSP_BENCH_WORKSPACE) to a benchmark workspace, or rely on the default '${BENCH_WORKSPACE}'. ` +
        `See plan benchmark-workspace-isolation-2026-06-18.`,
    );
  }
}

/**
 * Resolve a benchmark run's workspace. An explicit override (env / arg) wins — for a per-suite
 * sub-workspace; otherwise the shared {@link BENCH_WORKSPACE}. NEVER the production workspace (guarded).
 * Drop-in for `process.env.XBENCH_WORKSPACE_ID ?? 'papercusp-workspace'` ⇒
 * `resolveBenchWorkspace(process.env.XBENCH_WORKSPACE_ID)`.
 */
export function resolveBenchWorkspace(override?: string | null | undefined): string {
  const trimmed = typeof override === 'string' ? override.trim() : '';
  const ws = trimmed.length > 0 ? trimmed : BENCH_WORKSPACE;
  assertBenchWorkspace(ws);
  return ws;
}
