/**
 * pot:mug_efficiency — the per-wake Mug efficiency read surface
 * (queen-brief-cache-assembly-2026-06-13 B-06 / P-010: "expose it queryable").
 *
 * Read-only projection of `mugWakeEfficiency()` over `agent_usage_samples`
 * role='mug': the cache-hit ratio (Win-1, the frozen-prefix cache), avg
 * turns/wake (Win-2, round-trip elimination — the precomputed brief should pull
 * it down), token totals, and the `cachedWakes` "the cache is real" signal
 * (P-003). The pot-eval efficiency class scores these PER RUN (D-016); this is
 * the ad-hoc operator/Mug read of the LIVE pot's Mug.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import { mugWakeEfficiency } from '../../pot/mug-wake-efficiency';
import { refuseIfMugKettleRetired } from '../_mug-kettle-gate';

export default defineTool({
  name: 'pot:mug_efficiency',
  profile: 'engineer',
  description:
    "The Mug's per-wake prompt efficiency: cache-hit ratio (Win-1 frozen-prefix cache), avg turns/wake (Win-2 round-trip elimination), token + cost totals, and cachedWakes (the 'cache is real' signal, P-003). Scoped to a pot home, or workspace-wide when no harness is given. Read-only.",
  guidance: {
    when: "To inspect the LIVE Mug's per-wake efficiency — is the frozen-prefix cache paying off (cacheHitRatio / cachedWakes) and is the precomputed brief cutting round-trips (avgTurns)? The B-06 measurement read.",
    notWhen: 'For a SCENARIO run’s efficiency score — that is the pot-eval efficiency class (it scores these per run). This tool is the ad-hoc live-Mug read.',
    chaining: 'pot:status for the pot wake state; no Mug placement frontier is available while the Mug/Kettle/Cup tier is retired.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Home harness slug to scope to (default: ctx harness or PAPERCUSP_POT_HOME_SLUG; omit + none ⇒ all Mug wakes in the workspace).'),
    limit: z.number().int().min(1).max(500).optional().describe('Most-recent wakes to aggregate (default 50).'),
  }),
  async handler(args, ctx) {
    // D-048 ruled this TIER, from its own guidance: "inspect the LIVE Mug's
    // per-wake efficiency … the B-06 measurement read". Under retirement there
    // are no Mug wakes, so the honest answer is a refusal naming the flag — NOT
    // an all-zero report. That distinction is load-bearing: a zero here reads as
    // "the Mug is idle/efficient" when it actually means "the tier is retired",
    // the same zero-because-gated confound P-030 has to defend against on the
    // spawn baseline. Read-only, so this is not harm-prevention; it is refusing
    // to hand back a number whose units silently changed.
    const retired = await refuseIfMugKettleRetired(
      "read the Mug's wake efficiency",
      'There are no Mug wakes to measure. For the su engine loop use loop:soak_report / loop:session_audit.',
    );
    if (retired) return retired;
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    const eff = await mugWakeEfficiency(workspaceId, {
      harnessSlug: installSlug ?? undefined,
      limit: args.limit ?? 50,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug ?? null, // null ⇒ workspace-wide
            wakes: eff.wakes,
            cachedWakes: eff.cachedWakes, // wakes with non-zero cache_read — the "cache is real" signal (P-003)
            cacheHitRatio: eff.cacheHitRatio, // Win-1: cache_read / (cache_read + cache_creation + input)
            avgTurns: eff.avgTurns, // Win-2: mean turns over wakes that reported one (null if none)
            turnsReportedWakes: eff.turnsReportedWakes,
            totalInputTokens: eff.totalInputTokens,
            totalCacheReadTokens: eff.totalCacheReadTokens,
            totalCacheCreationTokens: eff.totalCacheCreationTokens,
            totalOutputTokens: eff.totalOutputTokens,
            totalCostUsd: eff.totalCostUsd,
            // a small recent-wakes preview (newest-first) — the full set is `limit` rows.
            recentSamples: eff.samples.slice(0, 10).map((s) => ({
              runId: s.runId,
              tsMs: s.tsMs,
              inputTokens: s.inputTokens,
              cacheReadTokens: s.cacheReadTokens,
              cacheCreationTokens: s.cacheCreationTokens,
              turns: s.turns,
              costUsd: s.costUsd,
            })),
          }),
        },
      ],
    };
  },
});
