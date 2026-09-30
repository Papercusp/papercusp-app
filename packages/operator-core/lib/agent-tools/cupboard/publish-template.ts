/**
 * cupboard:publish-template — list an app-template on the Cupboard's Templates
 * tab (cupboard-agent-tool-coverage-2026-07-14 P-002).
 *
 * The agent-callable face of `publishTemplateToCupboard` — the SAME core the
 * loopback POST /cupboard/publish-template route calls (D-001 reuse-first, no
 * fork). A template listing is mirror-repo-backed: it points at the public
 * templates repo with listing_ref = the per-template subdir; title/description
 * default from the local template when the ref resolves in the bundled store.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:publish-template',
  capability: 'harness:write',
  description:
    "List an app-template on the Cupboard's Templates tab: points a kind='template' listing at the public mirror repo the template lives in (githubUrl REQUIRED — a template has no git origin of its own) with listing_ref = the per-template subdir, published through the shared publish core (gh token + attestation). Title/description default from the local bundled template when the ref resolves.",
  guidance: {
    when: "Publishing an app-template (a materializable app scaffold) to the Cupboard so users can browse + materialize it — after its files are pushed to the public templates mirror repo.",
    notWhen:
      "Materializing/using a template (templates:new-app) or browsing what templates exist (templates:list); publishing a plugin/pack (cupboard:publish-plugin), blueprint (blueprint:publish), or standalone app (cupboard:publish-app).",
    chaining:
      'Push the template to its public mirror repo first (githubUrl points there). The response carries the listing + its review_status — a reviewed kind lands PENDING until an operator approves it at /admin/cupboard-moderation.',
    seeAlso: [
      'templates:list (browse app-templates available to materialize)',
      'cupboard:publish-plugin (publish a plugin/pack instead)',
      'cupboard:publish-app (publish a whole standalone app instead)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    ref: z
      .string()
      .min(1)
      .max(LIMITS.IDENT)
      .describe("The template's local ref/id (defaults title+description; also the default listing_ref)."),
    githubUrl: z
      .string()
      .min(1)
      .max(500)
      .describe('REQUIRED — the public mirror repo the template lives in (e.g. https://github.com/Papercusp/templates).'),
    listingRef: z.string().max(LIMITS.IDENT).optional().describe('Override the within-repo subdir (else `ref`).'),
    projectRef: z.string().max(200).optional().describe('Papercupai project remote (owner/repo).'),
    title: hardText(LIMITS.SHORT_TITLE).optional().describe('Override the listing title (else the local template title, else the ref).'),
    description: hardText(LIMITS.ANNOTATION).optional().describe('Override the listing description (else the local template description).'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    void (args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId());

    const { publishTemplateToCupboard } = await import('../../cupboard/publish-template-core');
    const result = await publishTemplateToCupboard({
      ref: args.ref,
      github_url: args.githubUrl,
      ...(args.listingRef ? { listing_ref: args.listingRef } : {}),
      ...(args.projectRef ? { project_ref: args.projectRef } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.description ? { description: args.description } : {}),
    });

    if (!result.ok) {
      return text({ ok: false, error: result.error, detail: result.detail, status: result.status });
    }
    const data = result.listing as { id?: string; review_status?: string; pending_review?: boolean };
    return text({
      ok: true,
      listingId: data.id,
      review_status: data.review_status ?? 'pending',
      hint:
        data.review_status === 'pending' || data.pending_review
          ? 'Published PENDING — an operator must approve it before it is publicly visible (you can watch your own listing meanwhile).'
          : undefined,
    });
  },
});
