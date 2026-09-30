import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:install-theme',
  capability: 'harness:write',
  description:
    'Install a Cupboard theme into this workspace. The validated semantic-token package becomes immediately available in the existing theme picker; installation does not select it. Pass update:true to replace an installed package explicitly.',
  guidance: {
    when: "Installing a result from cupboard:search { kind:'theme' } so it can be selected locally.",
    notWhen: 'Selecting an already installed theme or editing a local theme.',
    chaining: "cupboard:search { kind:'theme' } → cupboard:install-theme { listingId } → select the returned activeThemeId in the ordinary UI.",
    seeAlso: ['cupboard:publish-theme', 'cupboard:search'],
  },
  args: z.object({
    listingId: z.string().max(200).optional(),
    githubUrl: z.string().max(500).optional(),
    listingRef: z.string().max(200).optional(),
    update: z.boolean().optional(),
    workspace: entityRef('workspace', { max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    const subject = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const { gateInstallDoor } = await import('../../cupboard/install-door-gate-io');
    const gate = await gateInstallDoor({
      idOrRef: args.listingId ?? args.listingRef,
      kind: 'theme', subject,
    });
    if (!gate.ok) return ok({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    const { installThemeFromCupboard } = await import('../../cupboard/install-theme-io');
    const result = await installThemeFromCupboard({
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
      ...(args.update ? { update: true } : {}),
    });
    if (!result.ok) return ok({ ok: false, status: result.status, error: result.error, detail: result.detail });
    const { notifyThemeCatalogChanged } = await import('../../cupboard/theme-catalog-sync');
    await notifyThemeCatalogChanged().catch(() => {});
    return ok({ ...result.result, activeThemeId: `custom:${result.result.id}`, hint: 'Installed and available. Select it explicitly from the existing theme picker.' });
  },
});
