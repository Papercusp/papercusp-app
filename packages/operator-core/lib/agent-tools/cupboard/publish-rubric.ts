/**
 * cupboard:publish-rubric — list a rubric on the Cupboard's Rubrics tab
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-003).
 *
 * The agent-callable face of `publishRubricToCupboard`. A rubric listing is
 * mirror-repo-backed: it points at the public repo the rubric's self-describing dir
 * was pushed to (githubUrl REQUIRED — a rubric has no git origin of its own, its
 * content lives in the layered rubric store) with listing_ref = the per-rubric
 * subdir. Title/description default from the local rubric when the ref resolves.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';

/** Canonical `{ data }` envelope — the framework owns wire encoding (auto-TOON on the MCP transport). */
const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:publish-rubric',
  capability: 'harness:write',
  description:
    "List a rubric on the Cupboard's Rubrics tab: points a kind='rubric' listing at the public mirror repo the rubric's self-describing dir (rubric.json + listing.json + optional METHOD.md) was pushed to, with listing_ref = the per-rubric subdir. Title/description default from the local rubric. Rubrics are a reviewed kind — the publish lands PENDING until an operator approves it.",
  guidance: {
    when: "Sharing a rubric you authored so other workspaces can install and grade against it — after its dir is pushed to a public mirror repo.",
    notWhen:
      'Proposing/ratifying a rubric in THIS workspace (rubrics:propose / rubrics:ratify) — publishing is distribution, not authorship. Grading something (scorecards:emit). Publishing a plan template (cupboard:publish-plan) or a template (cupboard:publish-template).',
    chaining:
      'Push the rubric dir to its public mirror repo first (githubUrl points there). The response carries review_status — a reviewed kind lands PENDING until an operator approves it at /admin/cupboard-moderation.',
    seeAlso: [
      'cupboard:install-rubric (install a published rubric into this workspace)',
      'rubrics:list (see the rubrics this workspace already has)',
      'cupboard:publish-plan (publish a plan template instead)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    ref: z
      .string()
      .min(1)
      .max(LIMITS.IDENT)
      .describe("The rubric's local ref/rubricId (defaults title+description; also the default listing_ref)."),
    githubUrl: z
      .string()
      .min(1)
      .max(500)
      .describe('REQUIRED — the public mirror repo the rubric dir lives in.'),
    listingRef: z.string().max(LIMITS.IDENT).optional().describe('Override the within-repo subdir (else `ref`).'),
    projectRef: z.string().max(200).optional().describe('Papercupai project remote (owner/repo).'),
    title: hardText(LIMITS.SHORT_TITLE).optional().describe('Override the listing title (else the local rubric title, else the ref).'),
    description: hardText(LIMITS.ANNOTATION).optional().describe('Override the listing description (else the local rubric description / characteristic).'),
    workspace: entityRef('workspace', { max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    void (args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId());

    const { publishRubricToCupboard } = await import('../../cupboard/publish-rubric-core');
    const result = await publishRubricToCupboard({
      ref: args.ref,
      github_url: args.githubUrl,
      ...(args.listingRef ? { listing_ref: args.listingRef } : {}),
      ...(args.projectRef ? { project_ref: args.projectRef } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.description ? { description: args.description } : {}),
    });

    if (!result.ok) {
      return ok({ ok: false, error: result.error, detail: result.detail, status: result.status });
    }
    const data = result.listing as { id?: string; review_status?: string; pending_review?: boolean };
    return ok({
      ok: true,
      listingId: data.id,
      review_status: data.review_status ?? 'pending',
      hint:
        data.review_status === 'pending' || data.pending_review
          ? 'Published PENDING — a rubric grades other people\'s work, so an operator must approve it before it is publicly visible (you can see your own listing meanwhile).'
          : undefined,
    });
  },
});
