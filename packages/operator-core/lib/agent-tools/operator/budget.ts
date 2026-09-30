/**
 * operator:budget — read or set the daily operator budget cap.
 *   - { op: 'get' } → { configured, dailyCapUsd, todaySpendUsd, exceeded, spendHistory }
 *   - { op: 'set', dailyCapUsd } → set cap (operator role only)
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { checkBudget, setBudget } from '../../operator-budget';

export default defineTool({
  name: 'operator:budget',
  profile: 'engineer',
  description: 'Read or set the daily operator budget cap. Get is any role; set is operator only.',
  capability: 'operator:write',
  guidance: {
    when: `Read operator daily-spend status — todaySpendUsd, capUsd, exceeded flag.`,
    notWhen: `For voice-specific spend, use \`operator:voice_spend_summary\`. For raising the cap, use /settings/operator.`,
    seeAlso: [
      'operator:voice_spend_summary (voice-specific spend)',
      'operator:stats (broader operator stats)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 50 } },
  args: z.discriminatedUnion('op', [
    z.object({ op: z.literal('get') }),
    z.object({ op: z.literal('set'), dailyCapUsd: z.number().positive() }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'get') {
      const c = await checkBudget();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            configured: !!c.state,
            dailyCapUsd: c.capUsd,
            todaySpendUsd: c.todaySpendUsd,
            exceeded: c.exceeded,
            spendHistory: c.state?.spend ?? [],
          }),
        }],
      };
    }
    if (ctx.role !== 'operator') {
      throw new Error('operator:budget set requires operator role');
    }
    const next = await setBudget(args.dailyCapUsd);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, dailyCapUsd: next.dailyCapUsd }) }] };
  },
});
