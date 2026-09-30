/**
 * knowledge_packs:list — the pack catalog + (optionally) one hive's installed
 * state (learning-packs-2026-06-11 P-009).
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { FLAG_OFF, knowledgePacksEnabled, text } from './_shared';

export default defineTool({
  name: 'knowledge_packs:list',
  capability: 'memory:read',
  description:
    "List resolvable knowledge packs (builtin + Comb-installed) and, when `pot` is given, that hive's installed state: per-pack rows present/edited, enabled/disabled, and whether a newer pack version is adoptable.",
  guidance: {
    when:
      "Before knowledge_packs:install/upgrade (what's available + what's already in the hive), or when the user asks what learnings their hive carries.",
    notWhen:
      'To read the actual learning texts — learning.hive backs the Learnings UI, and memory:list { hive_slug } returns the rows.',
    chaining:
      'knowledge_packs:install { pot, pack } to add one; knowledge_packs:upgrade when updateAvailable; knowledge_packs:set_enabled to mute a pack without uninstalling.',
    seeAlso: [
      'knowledge_packs:install (add a pack)',
      'knowledge_packs:upgrade (when a pack shows updateAvailable)',
      'knowledge_packs:set_enabled (mute a pack without uninstalling)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120, describe: "Pot home slug — include this pot's installed state." }).optional(),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.principal?.workspaceId);
    const { listKnowledgePacks } = await import('../../knowledge-packs/load-packs');
    const packs = await listKnowledgePacks();

    if (!args.pot) return text({ ok: true, packs });

    const [{ readHiveLearnings }, { getMemoryBackend }, { loadKnowledgePack }, { disabledPacksFor }] =
      await Promise.all([
        import('../../sync-resolver/learning-hive-read'),
        import('../../memory/backend'),
        import('../../knowledge-packs/load-packs'),
        import('../../knowledge-packs/manage'),
      ]);
    const snap = await readHiveLearnings(args.pot, {
      listPool: async (scope) => {
        const backend = getMemoryBackend();
        const avail = await backend.available();
        if (!avail.ok) throw new Error(avail.reason);
        return backend.list({ scope });
      },
      loadPack: (id) => loadKnowledgePack(id),
    });
    const { semverGt } = await import('../../knowledge-packs/pack-format');
    const disabled = await disabledPacksFor(workspaceId, args.pot);
    const installed = snap.packs.map((p) => {
      const availableVersion = packs.find((a) => a.id === p.packId)?.version;
      return {
        ...p,
        enabled: !disabled.includes(p.packId),
        updateAvailable: semverGt(availableVersion, p.packVersion),
        availableVersion,
      };
    });
    return text({
      ok: true,
      packs,
      pot: args.pot,
      installed,
      organicCount: snap.organicCount,
      ...(snap.unavailable ? { unavailable: true } : {}),
    });
  },
});
