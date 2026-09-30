/**
 * The production agent-spawn runner for `orchestrator:spawn-roles`
 * (`coordination-ops-as-blueprint-primitives-2026-06-04`). Injected into the
 * coord-op caps via `setCoordSpawnRunner` (the orchestrator's
 * `setPipelineInvokeRunner` pattern) so prod-caps + the durable workflow carry no
 * agent-spawn plumbing and stay unit-testable with fake caps.
 *
 * Each resolved spec spawns one agent of the given role in the harness's project
 * dir, AWAITING completion. The injected context (question / options / lens /
 * conversation_id) reaches the agent two ways: as `CONVERSATION_ID=` / `LENS=`
 * positional extras AND as the `PAPERCUSP_COORD_INJECT` env (the full JSON) — the
 * voter/advocate prompts read the inject, deliberate, and post a structured vote
 * to the conversation via `coord:thread-post`. `collect` then reads those posts.
 *
 * Spawns run in PARALLEL when every spawn's backend isolates its per-spawn MCP
 * config in the SHARED project dir, else SEQUENTIALLY (D-014):
 *   - **claude** writes its signed config to a UNIQUE per-spawn temp dir and
 *     loads it via `--mcp-config … --strict-mcp-config` (invoke.ts) — so several
 *     claude spawns in one cwd never touch a shared file. Race-safe → parallel.
 *   - **codex** uses a per-spawn `CODEX_HOME` (no `.mcp.json`). Race-safe → parallel.
 *   - **omp** path-discovers the SHARED `<projectDir>/.mcp.json` and has no
 *     explicit-path override, so two omp spawns sharing a cwd race-clobber that
 *     file → both authenticate under ONE role (a voter posting as the advocate,
 *     verified live 2026-06-04), collapsing the per-lens diversity the vote
 *     depends on (D-010). So an omp fan-out STAYS sequential (each write→read→
 *     restore stays atomic). Votes are independent per lens, so parallel costs
 *     nothing but wall-clock — an N-lens vote goes from N× to ~1× spawn time.
 * The backend is resolved per role via `resolveSpawnBackendModel` (AGENT_CMD /
 * AGENT_MODELS), so a box on the default `omp -p` keeps the safe sequential path.
 */
import { resolveProject } from '../harness-core.js';
import { spawnInvokeOnce } from './orchestrator-runner.js';
import { resolveSpawnBackendModel } from '../harness-invoke-once.js';
import { buildPipelineExtraEnv } from './orchestrator-spawn-env.js';
import { setCoordSpawnRunner, type CoordSpawnRunner } from '../coord-ops/prod-caps.js';

/** Exported for unit testing the parallel-vs-sequential dispatch (D-014). */
export const coordSpawnRunner: CoordSpawnRunner = async (specs, opts) => {
  const project = opts.harnessSlug ? await resolveProject(opts.harnessSlug, opts.workspaceId) : null;
  if (!project) {
    console.error(`[coord-spawn] resolveProject NULL — harness=${opts.harnessSlug ?? '(none)'} ws=${opts.workspaceId ?? '(none)'}`);
    return { spawned: specs.map((s) => ({ role: s.role, inject: s.inject, ok: false })), launched: 0 };
  }

  // Spawn one role into the harness project dir, AWAITING completion. Never
  // rejects: spawnInvokeOnce captures the child's exit/stderr, and the try/catch
  // guards the rest, so one failed spawn can't abort the fan-out (and Promise.all
  // below can't reject).
  const spawnOne = async (
    s: (typeof specs)[number],
  ): Promise<{ role: string; inject: Record<string, unknown>; ok: boolean }> => {
    const convId = String(s.inject.conversation_id ?? '');
    const extras = [`CONVERSATION_ID=${convId}`];
    if (s.inject.lens != null) extras.push(`LENS=${String(s.inject.lens)}`);
    // The owning blueprint, so invoke() resolves the role's prompt from
    // blueprints/<blueprintId>/prompts/<role>.md (program-blueprint roles aren't
    // global prompts/<role>.md). Mirrors the CONVERSATION_ID / LENS extras.
    if (s.blueprintId) extras.push(`BLUEPRINT_ID=${s.blueprintId}`);
    const extraEnv: Record<string, string | undefined> = {
      ...buildPipelineExtraEnv({ harnessSlug: opts.harnessSlug!, workspaceId: opts.workspaceId }),
      PAPERCUSP_COORD_INJECT: JSON.stringify(s.inject),
    };
    let ok = false;
    try {
      const r = await spawnInvokeOnce(project.path, s.role, extras, extraEnv);
      ok = r.exitCode === 0;
    } catch (err) {
      console.error(`[coord-spawn] role=${s.role} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { role: s.role, inject: s.inject, ok };
  };

  // Parallel only when EVERY spawn's backend isolates its per-spawn MCP config in
  // a shared cwd (claude → unique --mcp-config temp dir; codex → per-spawn
  // CODEX_HOME). Any omp spawn forces the whole fan-out sequential — the shared
  // `<cwd>/.mcp.json` it path-discovers would race-clobber under concurrency
  // (see header). Resolved per role so backend overrides (AGENT_MODELS) are honored.
  const raceSafe = (role: string): boolean => {
    const { backend } = resolveSpawnBackendModel(role);
    return backend === 'claude-code' || backend === 'codex';
  };
  const canParallelize = specs.every((s) => raceSafe(s.role));

  let spawned: { role: string; inject: Record<string, unknown>; ok: boolean }[];
  if (canParallelize) {
    spawned = await Promise.all(specs.map(spawnOne));
  } else {
    spawned = [];
    for (const s of specs) spawned.push(await spawnOne(s));
  }

  return { spawned, launched: specs.length };
};

/** Wire the production coord spawn runner. Called once at DBOS boot. */
export function wireCoordSpawnRunner(): void {
  setCoordSpawnRunner(coordSpawnRunner);
}
