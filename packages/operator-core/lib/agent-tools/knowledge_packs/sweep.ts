/**
 * knowledge_packs:sweep — on-demand conflict sweep over a hive's whole shared
 * memory (learning-packs-2026-06-11 P-012). Read-only: reports contradiction
 * pairs; resolving them (memory:forget / memory:update one side) stays a
 * deliberate follow-up act.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { FLAG_OFF, knowledgePacksEnabled, text } from './_shared';

export default defineTool({
  name: 'knowledge_packs:sweep',
  capability: 'memory:read',
  description:
    "Re-run the conflict judge across a hive's whole shared memory pool and report contradiction pairs — catches conflicts that emerged AFTER install (pack learnings vs what the hive organically learned later). Read-only; capped at 200 rows per sweep.",
  guidance: {
    when:
      'Periodic hygiene (an idle-turn task), after installing a pack into a hive with many organic learnings, or when agents seem to be following contradictory guidance.',
    notWhen: 'At install time — knowledge_packs:install runs its own per-item review.',
    chaining: 'Resolve a reported pair deliberately: memory:forget the wrong side, or memory:update it to reconcile.',
    seeAlso: [
      'memory:forget (drop the wrong side of a reported contradiction)',
      'memory:update (reconcile the pair instead of dropping)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120 }),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    const { sweepHiveConflicts } = await import('../../knowledge-packs/manage');
    const result = await sweepHiveConflicts({ potSlug: args.pot });
    return text({ ok: true, ...result });
  },
});
