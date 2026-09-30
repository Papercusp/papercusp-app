/**
 * knowledge_packs:upgrade — adopt a newer pack version's NEW learnings
 * (learning-packs-2026-06-11 P-013). Present rows are never auto-touched —
 * the store can't distinguish user edits from pack drift, and
 * never-clobber-user-edits is the D-003 line.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { getSessionUserOrDefault } from '../../auth';
import { FLAG_OFF, knowledgePacksEnabled, text } from './_shared';

export default defineTool({
  name: 'knowledge_packs:upgrade',
  capability: 'memory:write',
  description:
    "Adopt a newer version of an installed knowledge pack: NEW items (no row in the hive's pool) are classified like an install and added per your resolutions; rows already present are never auto-modified. Call once for the plan, re-call with resolutions (or acceptDefaults: true) to apply.",
  guidance: {
    when: 'knowledge_packs:list shows updateAvailable for an installed pack.',
    notWhen: 'First-time install — knowledge_packs:install.',
    chaining: 'The response reports installedVersions vs availableVersion + the adoptable-new-items review.',
    seeAlso: [
      'knowledge_packs:list (see which packs show updateAvailable)',
      'knowledge_packs:install (first-time install, not an upgrade)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120 }),
    pack: z.string().min(1).max(120),
    resolutions: z
      .array(z.object({ itemId: z.string().min(1), action: z.enum(['install', 'skip', 'replace', 'keep-both']) }))
      .optional(),
    acceptDefaults: z.boolean().optional(),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.principal?.workspaceId);
    const { loadKnowledgePack } = await import('../../knowledge-packs/load-packs');
    const loaded = await loadKnowledgePack(args.pack);
    if (!loaded) return text({ ok: false, reason: 'pack_not_found', pack: args.pack });

    const { planPackUpgrade, applyPackInstall } = await import('../../knowledge-packs/manage');
    const plan = await planPackUpgrade({ potSlug: args.pot, pack: loaded.pack });

    if (plan.newItems.items.length === 0) {
      return text({ ok: true, upToDate: true, ...plan, hint: 'No new items to adopt.' });
    }
    const hasClashes = plan.newItems.duplicates + plan.newItems.conflicts > 0;
    if (!args.resolutions && args.acceptDefaults !== true && hasClashes) {
      return text({
        ok: false,
        reason: 'review_required',
        plan,
        hint: 'New items clash with existing learnings — re-call with resolutions or acceptDefaults: true.',
      });
    }
    const result = await applyPackInstall({
      workspaceId,
      potSlug: args.pot,
      pack: loaded.pack,
      review: plan.newItems,
      ...(args.resolutions ? { resolutions: args.resolutions } : {}),
      createdBy: (await getSessionUserOrDefault()).id,
    });
    return text({ ...result, installedVersions: plan.installedVersions, availableVersion: plan.availableVersion });
  },
});
