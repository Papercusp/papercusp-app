/**
 * knowledge_packs:install — install a pack into an existing hive, through the
 * install-time conflict review (learning-packs-2026-06-11 P-009/P-010, D-003).
 *
 * Two-step contract (never a silent union):
 *   1. call without `resolutions` → classification runs; clashes (duplicates /
 *      conflicts) return `review_required` + the per-item report with
 *      preselected defaults; a fully-clean pack installs immediately.
 *   2. re-call with `resolutions` (or `acceptDefaults: true`) → applies.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { getSessionUserOrDefault } from '../../auth';
import { FLAG_OFF, knowledgePacksEnabled, text } from './_shared';

export default defineTool({
  name: 'knowledge_packs:install',
  capability: 'memory:write',
  description:
    "Install a knowledge pack into an existing hive's shared memory, with the install-time conflict review: incoming learnings are classified clean/duplicate/conflict against the hive's current pool; clashes require explicit per-item resolutions (install · skip · replace · keep-both). Defaults skip clashes — existing content outranks the incoming pack.",
  guidance: {
    when:
      "Adding a pack to an EXISTING hive (a new hive seeds its pack at creation). Call once to get the review; re-call with resolutions (or acceptDefaults: true) to apply.",
    notWhen:
      'At hive creation (pot:create seeds automatically). To re-adopt a newer version of an already-installed pack — knowledge_packs:upgrade.',
    chaining:
      "knowledge_packs:list { pot } first (what's installed); after install, learning.hive invalidates so the Learnings view refreshes.",
    seeAlso: [
      'knowledge_packs:list (browse available packs first)',
      'knowledge_packs:set_enabled (try / quarantine without uninstalling)',
      'knowledge_packs:uninstall (remove it entirely)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    pot: entityRef('pot', { soft: true, max: 120, describe: 'Pot home slug.' }),
    pack: z.string().min(1).max(120).describe('Pack id (knowledge_packs:list enumerates).'),
    resolutions: z
      .array(z.object({ itemId: z.string().min(1), action: z.enum(['install', 'skip', 'replace', 'keep-both']) }))
      .optional()
      .describe('Per-item decisions from a prior review_required response.'),
    acceptDefaults: z
      .boolean()
      .optional()
      .describe('Apply the review with its preselected defaults (clashes skipped) without itemized resolutions.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.principal?.workspaceId);
    const { loadKnowledgePack } = await import('../../knowledge-packs/load-packs');
    const loaded = await loadKnowledgePack(args.pack);
    if (!loaded) return text({ ok: false, reason: 'pack_not_found', pack: args.pack });

    const { classifyPackInstall, applyPackInstall } = await import('../../knowledge-packs/manage');
    const review = await classifyPackInstall({ potSlug: args.pot, pack: loaded.pack });

    const hasClashes = review.duplicates + review.conflicts > 0;
    if (hasClashes && !args.resolutions && args.acceptDefaults !== true) {
      return text({
        ok: false,
        reason: 'review_required',
        review,
        hint:
          'Clashes found — re-call with per-item resolutions (or acceptDefaults: true to take the preselected defaults, which skip every clash). replace = forget the clashing existing row and write the incoming learning; keep-both = write incoming alongside it.',
      });
    }

    const result = await applyPackInstall({
      workspaceId,
      potSlug: args.pot,
      pack: loaded.pack,
      review,
      ...(args.resolutions ? { resolutions: args.resolutions } : {}),
      createdBy: (await getSessionUserOrDefault()).id,
    });
    return text({ ...result, review: { clean: review.clean, duplicates: review.duplicates, conflicts: review.conflicts } });
  },
});
