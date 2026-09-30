/**
 * Usage / cost aggregation:
 *
 *   GET /api/harness/:slug/usage    — totals + byRole + byFeature + recent runs (top 20)
 *
 * Reads `harness_<slug>.agent_runs` via the shared scanAgentRuns helper and
 * force-syncs to PG so this and /agents stay coherent. Only counts runs
 * that have produced at least one cost/duration/token signal — in-flight
 * or aborted runs without a `result` line are excluded.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 35). Helpers `scanAgentRuns` / `syncAgentRunsToPg` carved out
 * to `lib/harness-agent-runs.ts` in the same batch.
 */
import { resolvePhasedProject } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { scanAgentRuns, syncAgentRunsToPg } from '../../../harness-agent-runs';
import { defineTool } from '@papercusp/agent-mcp';

function zeroUsage() {
  return { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0 };
}
function zeroRoleSummary(role: string) {
  return { role, runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0 };
}

const usage = defineTool({
  method: 'GET',
  path: '/harness/:slug/usage',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const all = scanAgentRuns(project);
    // Force-sync to PG so usage and /agents stay coherent.
    syncAgentRunsToPg(project, all).catch((err) => {
      console.warn(`[usage] PG sync failed for ${project.slug}:`, err?.message ?? err);
    });
    // Only count runs with a result line (cost > 0 OR duration > 0 OR tokens > 0).
    const runs = all.filter((r) =>
      r.costUsd > 0 || r.durationMs > 0 || r.inputTokens > 0 || r.outputTokens > 0
    );
    if (runs.length === 0 && all.length === 0) {
      return Response.json({ totals: zeroUsage(), byRole: [], recent: [] });
    }

    const totals = runs.reduce((acc, r) => {
      acc.runs += 1;
      acc.costUsd += r.costUsd;
      acc.inputTokens += r.inputTokens;
      acc.outputTokens += r.outputTokens;
      acc.cacheReadTokens += r.cacheReadTokens;
      acc.cacheCreationTokens += r.cacheCreationTokens;
      acc.durationMs += r.durationMs;
      return acc;
    }, zeroUsage());

    const rolesMap = new Map<string, ReturnType<typeof zeroRoleSummary>>();
    for (const r of runs) {
      let entry = rolesMap.get(r.role);
      if (!entry) { entry = zeroRoleSummary(r.role); rolesMap.set(r.role, entry); }
      entry.runs += 1;
      entry.costUsd += r.costUsd;
      entry.inputTokens += r.inputTokens;
      entry.outputTokens += r.outputTokens;
      entry.cacheReadTokens += r.cacheReadTokens;
      entry.cacheCreationTokens += r.cacheCreationTokens;
      entry.durationMs += r.durationMs;
    }
    const byRole = Array.from(rolesMap.values())
      .map((e) => ({
        ...e,
        avgCostUsd: e.runs ? e.costUsd / e.runs : 0,
        avgDurationMs: e.runs ? e.durationMs / e.runs : 0,
      }))
      .sort((a, b) => b.costUsd - a.costUsd);

    const featuresMap = new Map<string, { featureId: string; runs: number; costUsd: number; inputTokens: number; outputTokens: number; durationMs: number; byRole: Record<string, number> }>();
    for (const r of runs) {
      if (!r.featureId) continue;
      let entry = featuresMap.get(r.featureId);
      if (!entry) { entry = { featureId: r.featureId, runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, byRole: {} }; featuresMap.set(r.featureId, entry); }
      entry.runs += 1;
      entry.costUsd += r.costUsd;
      entry.inputTokens += r.inputTokens;
      entry.outputTokens += r.outputTokens;
      entry.durationMs += r.durationMs;
      entry.byRole[r.role] = (entry.byRole[r.role] ?? 0) + r.costUsd;
    }
    const byFeature = Array.from(featuresMap.values())
      .map((e) => ({ ...e, avgCostUsd: e.runs ? e.costUsd / e.runs : 0 }))
      .sort((a, b) => b.costUsd - a.costUsd);

    const recent = runs
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 20);

    return Response.json({ totals, byRole, byFeature, recent });
  },
});

export default [usage];
