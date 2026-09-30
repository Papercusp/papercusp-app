/**
 * config:tiers-set — replace the model-tier menu (incl. per-tier compaction limits).
 *
 * context-trimming-tiers-2026-07-01 (P-005/D-002): every place a user configures
 * model tiers carries an optional soft compaction limit; this is the defineTool
 * write surface for the menu (the /settings/agent page edits the same stored
 * config). REPLACE-WHOLESALE semantics, matching the menu's contract ("the
 * user's own menu replaces the defaults wholesale"); pass [] to clear back to
 * DEFAULT_MODEL_TIERS. Entries are validated exactly like the stored config
 * (parseTiers): bad rows drop, a bad compactionLimit drops to the model-derived
 * default, an in-range one is clamped so limit × 1.2 ≤ window − margin (D-001).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readAgentConfig, writeAgentConfig, parseTiers } from '../../agent-config';
import { readOmpModelCatalog } from '../../omp-config';
import {
  AGENT_BACKENDS,
  defaultCompactionLimitForTier,
  modelWindowForTier,
} from '../../agent-config-constants';
import { classifyLoopModelSpec } from '../../agent-loop/model-selection';

const withoutEffort = (spec: string): string =>
  spec.replace(/:(?:minimal|low|medium|high|xhigh|max|ultra)$/i, '');

export default defineTool({
  name: 'config:tiers-set',
  profile: 'engineer',
  description:
    'Replace the model-tier menu wholesale (names, specs, backends, when-guidance, per-tier soft compaction limits). Invalid rows are dropped and limits clamped to each spec’s model-derived ceiling (limit × 1.2 ≤ window − margin). Pass tiers: [] to revert to the committed defaults.',
  capability: 'operator:write',
  guidance: {
    when: 'Editing the tier menu — adding a tier, changing a spec, or setting a per-tier compaction limit the fleet seeds sessions with.',
    notWhen:
      'To change YOUR OWN session’s limit — config:set-compaction-limit. To read the menu — config:tiers-get.',
    chaining: 'config:tiers-get first to see the current menu; edit; write back the full array.',
    seeAlso: ['config:tiers-get (read the menu)', 'config:set-compaction-limit (your own session’s limit)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    tiers: z
      .array(
        z.object({
          name: z.string().min(1).max(60).describe('Tier name (short, lowercase — the cup:spawn `tier` key).'),
          spec: z.string().min(1).max(120).describe('Model spec `<modelId>[:<effort>]`, e.g. "sonnet", "opus:xhigh", "opus[1m]:high".'),
          backend: z.enum(AGENT_BACKENDS).optional().describe('Backend override for this tier; absent = inherit the host backend.'),
          when: z.string().max(300).optional().describe('One-line guidance: when an agent should pick this tier.'),
          compactionLimit: z
            .number()
            .int()
            .optional()
            .describe(
              'Soft compaction limit (tokens) sessions on this tier are seeded with. Omit for the tier default. Clamped to [20k, that default] — floor((window − 10k) / 1.2), capped by the role cost cap where one binds (400k on [1m]).',
            ),
        }),
      )
      .max(20)
      .describe('The FULL replacement menu, ordered weakest → strongest. [] reverts to the committed defaults.'),
  }),
  async handler(args) {
    const needsOmpCatalog = args.tiers.some((tier) => tier.backend === 'omp');
    const ompModels = needsOmpCatalog ? (await readOmpModelCatalog()).models : [];
    const hydrated = args.tiers.map((tier) => {
      if (tier.backend !== 'omp') return tier;
      const selector = withoutEffort(tier.spec);
      const contextWindow = ompModels.find((model) => model.selector === selector)?.contextWindow;
      return contextWindow != null && contextWindow > 0 ? { ...tier, contextWindow } : tier;
    });
    const parsed = parseTiers(hydrated);
    const dropped = args.tiers.length - parsed.length;
    const cfg = await readAgentConfig();
    const next = await writeAgentConfig({ ...cfg, tiers: parsed });
    const tiers = (next.tiers ?? []).map((t) => ({
      ...t,
      modelWindow: modelWindowForTier(t),
      effectiveCompactionLimit: t.compactionLimit ?? defaultCompactionLimitForTier(t),
      loopCapability: classifyLoopModelSpec(t.spec),
    }));
    return {
      data: {
        ok: true,
        stored: tiers.length > 0,
        tiers,
        ...(dropped > 0 ? { droppedInvalid: dropped, note: `${dropped} invalid row(s) dropped by validation` } : {}),
        ...(tiers.length === 0 ? { note: 'menu cleared — the committed DEFAULT_MODEL_TIERS apply' } : {}),
      },
    };
  },
});
