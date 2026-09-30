/**
 * cupboard:publish-plan — list a plan TEMPLATE on the Cupboard's Plans tab
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-009).
 *
 * The agent-callable face of `publishPlanToCupboard`. Unlike every other publish
 * verb, this one SANITIZES first: a plan in this system fuses a reusable shape (goal,
 * item DAG, decisions, prose) with a run log (statuses, notes naming work-items and
 * agents, the `## Now` block, identity frontmatter). Publishing the run log would hand
 * an installer someone else's finished work as their to-do list and leak this
 * workspace's identifiers, so it is stripped — and the response REPORTS what was
 * stripped, because a sanitizer nobody inspects is one nobody notices has stopped.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';

/** Canonical `{ data }` envelope — the framework owns wire encoding (auto-TOON on the MCP transport). */
const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:publish-plan',
  capability: 'harness:write',
  description:
    "List a plan template on the Cupboard's Plans tab. SANITIZES the source plan first (item statuses → todo, set-status notes / work-item ids / the ## Now block / identity frontmatter removed; goal, item DAG, decisions and prose kept), materializes it as a self-describing dir (plan.md + listing.json) under ~/.papercusp/plan-templates/<ref>/, then points a kind='plan' listing at the public mirror repo you pushed that dir to. Derives requires_rubrics from the plan's acceptance class + any rubricRefs it names. Pass exportOnly to materialize the dir WITHOUT publishing (the honest order is export → push → publish). Plans are a reviewed kind — the publish lands PENDING until an operator approves it.",
  guidance: {
    when: 'Sharing a plan you authored as a reusable template so other workspaces can install and instantiate it.',
    notWhen:
      'Creating or editing a plan here (plans:new / plans:set-*). Exporting a plan for a one-off offline copy (plans:export). Publishing a rubric (cupboard:publish-rubric) or an app template (cupboard:publish-template).',
    chaining:
      'cupboard:publish-plan { slug, exportOnly: true } → push the returned dir to a public mirror repo → cupboard:publish-plan { slug, githubUrl } to create the listing. Read `stripped` in the response to confirm the run log came out.',
    seeAlso: [
      'cupboard:install-plan (install a published plan template)',
      'plans:export (raw markdown of a plan, unsanitized — not for publishing)',
      'cupboard:publish-rubric (publish a rubric a plan requires)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    slug: z.string().min(1).max(LIMITS.IDENT).describe('The SOURCE plan slug in this workspace — what gets sanitized and published.'),
    harness: entityRef('harness', { soft: true, max: 120, describe: 'Harness scope for the plan lookup.' }).optional(),
    githubUrl: z
      .string()
      .max(500)
      .optional()
      .describe('The public mirror repo the exported dir lives in. Required unless exportOnly.'),
    exportOnly: z
      .boolean()
      .optional()
      .describe('Materialize the sanitized dir and STOP — no listing is created. Use this first, then push, then publish.'),
    listingRef: z.string().max(LIMITS.IDENT).optional().describe('Override the within-repo subdir / dir name (else the template slug).'),
    templateSlug: z.string().max(LIMITS.IDENT).optional().describe('Override the slug the exported template declares (else the source plan slug).'),
    projectRef: z.string().max(200).optional().describe('Papercupai project remote (owner/repo).'),
    title: hardText(LIMITS.SHORT_TITLE).optional().describe("Override the listing title (else the plan's title)."),
    description: hardText(LIMITS.ANNOTATION).optional().describe("Override the description (else the plan's first prose paragraph)."),
    version: z.string().max(40).optional().describe('Template version recorded in listing.json (storefront only).'),
    workspace: entityRef('workspace', { max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    void (args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId());

    if (!args.githubUrl && args.exportOnly !== true) {
      return ok({
        ok: false,
        error: 'githubUrl required (the public mirror repo the exported dir lives in)',
        hint: 'Run with exportOnly: true first to materialize the dir, push it, then re-run with githubUrl.',
      });
    }

    const { publishPlanToCupboard } = await import('../../cupboard/publish-plan-core');
    const result = await publishPlanToCupboard({
      slug: args.slug,
      ...(args.harness ? { harness: args.harness } : {}),
      ...(args.githubUrl ? { github_url: args.githubUrl } : {}),
      ...(args.listingRef ? { listing_ref: args.listingRef } : {}),
      ...(args.templateSlug ? { template_slug: args.templateSlug } : {}),
      ...(args.projectRef ? { project_ref: args.projectRef } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.version ? { version: args.version } : {}),
      ...(args.exportOnly === true ? { exportOnly: true } : {}),
    });

    if (!result.ok) {
      return ok({ ok: false, error: result.error, detail: result.detail, status: result.status });
    }

    const e = result.export;
    const common = {
      ref: e.written.ref,
      dir: e.written.dir,
      templateSlug: e.templateSlug,
      title: e.title,
      itemCount: e.itemCount,
      decisionCount: e.decisionCount,
      requiresRubrics: e.requiresRubrics,
      stripped: e.stripped,
    };

    if (result.exportedOnly) {
      return ok({
        ok: true,
        exportedOnly: true,
        ...common,
        hint: `Sanitized template written to ${e.written.dir}. Push that directory to a public repo as <repo>/${e.written.ref}/, then re-run with githubUrl to create the listing.`,
      });
    }

    const data = result.listing as { id?: string; review_status?: string; pending_review?: boolean };
    return ok({
      ok: true,
      exportedOnly: false,
      listingId: data.id,
      review_status: data.review_status ?? 'pending',
      ...common,
      hint:
        data.review_status === 'pending' || data.pending_review
          ? 'Published PENDING — a plan template tells another workspace what to DO, so an operator must approve it before it is publicly visible (you can see your own listing meanwhile).'
          : undefined,
    });
  },
});
