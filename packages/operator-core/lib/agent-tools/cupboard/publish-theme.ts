import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { BUILTIN_THEME_IDS } from '../../theme-tokens';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:publish-theme',
  capability: 'harness:write',
  crossWorkspace: true,
  description:
    "Export one locally-authored theme as theme.json + listing.json and list it on the Cupboard's Themes tab. The public GitHub mirror and listing ref identify the package. Pass exportOnly to materialize the package before pushing it.",
  guidance: {
    when: 'Sharing a theme from Personalization so another workspace can install and select it.',
    notWhen: 'Creating/editing a local theme, selecting a theme, or installing an existing theme listing.',
    chaining: 'Export first, push the returned directory to the named public mirror, then publish the listing; consumers use cupboard:install-theme.',
    seeAlso: ['cupboard:install-theme', 'cupboard:search', 'cupboard:unpublish'],
  },
  args: z.object({
    themeId: z.string().min(1).max(80),
    githubUrl: z.string().url().max(500),
    listingRef: z.string().max(200).optional(),
    projectRef: z.string().max(300).optional(),
    version: z.string().max(64).optional(),
    baseTheme: z.enum(BUILTIN_THEME_IDS).optional(),
    colorScheme: z.enum(['light', 'dark']).optional(),
    title: z.string().max(200).optional(),
    description: z.string().max(280).optional(),
    exportOnly: z.boolean().optional(),
    workspace: entityRef('workspace', { max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    void (args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId());
    const { publishThemeToCupboard } = await import('../../cupboard/publish-theme-core');
    const result = await publishThemeToCupboard({
      themeId: args.themeId,
      github_url: args.githubUrl,
      ...(args.listingRef ? { listing_ref: args.listingRef } : {}),
      ...(args.projectRef ? { project_ref: args.projectRef } : {}),
      ...(args.version ? { version: args.version } : {}),
      ...(args.baseTheme ? { baseTheme: args.baseTheme } : {}),
      ...(args.colorScheme ? { colorScheme: args.colorScheme } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.exportOnly === true ? { exportOnly: true } : {}),
    });
    if (!result.ok) return ok({ ok: false, status: result.status, error: result.error, detail: result.detail });
    const listing = result.listing as { id?: string; review_status?: string } | undefined;
    return ok({
      ok: true,
      exportedOnly: result.exportedOnly,
      ref: result.export.ref,
      exportedTo: result.export.dir,
      listingId: listing?.id,
      review_status: listing?.review_status,
      hint: result.exportedOnly
        ? 'Push this self-describing directory to the matching path in the public mirror, then call again without exportOnly.'
        : 'Published. Installing adds the theme to the picker; selecting it remains explicit.',
    });
  },
});
