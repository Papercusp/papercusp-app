/**
 * config:tiers-get — read the model-tier menu with effective compaction limits.
 *
 * context-trimming-tiers-2026-07-01 (P-005/D-002): the tier menu is the owner's
 * per-tier configuration surface, and each tier now carries an optional soft
 * compaction limit. This read reports the EFFECTIVE menu (stored, else
 * DEFAULT_MODEL_TIERS) with, per tier, the model window it resolves to and the
 * effective compaction limit (explicit ?? model-derived default — D-001:
 * floor((window − margin) / 1.2), the 20% overshoot allowance).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readAgentConfig } from '../../agent-config';
import {
  DEFAULT_MODEL_TIERS,
  defaultCompactionLimitForTier,
  modelWindowForTier,
} from '../../agent-config-constants';
import { classifyLoopModelSpec } from '../../agent-loop/model-selection';

export default defineTool({
  name: 'config:tiers-get',
  profile: 'engineer',
  description:
    'Read the model-tier menu (stored, else the committed defaults) with each tier’s effective soft compaction limit — explicit per-tier value, else the model-derived default floor((window − margin) / 1.2). Also returns the per-role tier ceilings.',
  capability: 'operator:read',
  guidance: {
    when: 'You need the tier menu (names, specs, backends) or the compaction limit a tier would seed — e.g. before editing it via config:tiers-set or picking a capability:launch-agent / fleet:launch-on-plan tier.',
    notWhen:
      'To change YOUR OWN session’s limit — config:set-compaction-limit. To edit the menu — config:tiers-set.',
    seeAlso: ['config:tiers-set (edit the menu)', 'config:set-compaction-limit (your own session’s limit)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 60 } },
  args: z.object({}),
  async handler() {
    const cfg = await readAgentConfig();
    const stored = (cfg.tiers?.length ?? 0) > 0;
    const menu = stored ? cfg.tiers! : [...DEFAULT_MODEL_TIERS];
    const tiers = menu.map((t) => ({
      ...t,
      modelWindow: modelWindowForTier(t),
      effectiveCompactionLimit: t.compactionLimit ?? defaultCompactionLimitForTier(t),
      compactionLimitSource: t.compactionLimit != null ? ('explicit' as const) : ('model-default' as const),
      loopCapability: classifyLoopModelSpec(t.spec),
    }));
    return {
      data: {
        ok: true,
        stored,
        tiers,
        tierCeilings: cfg.tierCeilings ?? {},
      },
    };
  },
});
