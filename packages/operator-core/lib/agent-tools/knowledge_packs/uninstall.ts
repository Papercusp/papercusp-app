/**
 * knowledge_packs:uninstall — remove a pack's rows from a hive's shared memory
 * (learning-packs-2026-06-11 P-009). Provenance-driven; user-edited rows are
 * kept by default (they're the user's words now).
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { FLAG_OFF, knowledgePacksEnabled, text } from './_shared';

export default defineTool({
  name: 'knowledge_packs:uninstall',
  capability: 'memory:write',
  description:
    "Remove a knowledge pack's rows from a hive's shared memory (provenance-driven). Rows the user edited since seeding are KEPT by default and reported; keepEdited: false removes those too. Organic (hive-learned) rows are never touched.",
  guidance: {
    when: 'The user wants a pack gone from a pot, or before re-installing a pack from scratch.',
    notWhen:
      'To temporarily mute a pack — knowledge_packs:set_enabled { enabled: false } keeps the rows and just stops injecting them.',
    chaining: 'knowledge_packs:list { pot } shows what remains; kept edited rows are listed in the response.',
    seeAlso: [
      'knowledge_packs:set_enabled (quarantine instead of removing)',
      'knowledge_packs:list (see what remains after)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120 }),
    pack: z.string().min(1).max(120),
    keepEdited: z.boolean().optional().describe('Default true — edited rows survive the uninstall.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    const { loadKnowledgePack } = await import('../../knowledge-packs/load-packs');
    const { uninstallPack } = await import('../../knowledge-packs/manage');
    const loaded = await loadKnowledgePack(args.pack);
    const result = await uninstallPack({
      potSlug: args.pot,
      packId: args.pack,
      pack: loaded?.pack ?? null,
      ...(args.keepEdited !== undefined ? { keepEdited: args.keepEdited } : {}),
    });
    return text({ ...result });
  },
});
