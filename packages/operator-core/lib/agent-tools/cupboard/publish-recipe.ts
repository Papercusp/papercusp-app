/**
 * cupboard:publish-recipe — list a recipe on the Cupboard's Recipes tab
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-014).
 *
 * The agent-callable face of `publishRecipeToCupboard`. Like the plan kind it
 * sanitizes and materializes before it lists (a recipe lives in Postgres and has no
 * dir until something writes one), and like the plan kind it offers `exportOnly` so
 * the publisher can push the dir before the listing points at it.
 *
 * The refusal worth knowing about up front: a recipe whose SCRIPT names concrete
 * workspace-scoped refs — a plan slug, a work-item id, a fleet, a literal workspace —
 * is refused, with the refs named. It is not laundered, because rewriting the script
 * would publish something that runs and does something other than what its title
 * says. Generalize the recipe and re-capture it instead.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';

/** Canonical `{ data }` envelope — the framework owns wire encoding (auto-TOON on the MCP transport). */
const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:publish-recipe',
  capability: 'harness:write',
  description:
    "List a recipe on the Cupboard's Recipes tab. Sanitizes first (usage + attribution columns — runCount, potSlug, createdBy, status … — are dropped; the per-run authority proof was never stored), materializes recipe.json + listing.json under ~/.papercusp/recipes/<ref>/, then points a kind='recipe' listing at the public mirror repo you pushed that dir to, with provides_tools from the recipe's toolsUsed. REFUSES a recipe whose script names concrete workspace-scoped refs (plan slug / work-item id / fleet / workspace) — it would not work elsewhere and is not rewritten silently. Pass exportOnly to materialize without publishing. Recipes are a reviewed kind: the publish lands PENDING until an operator approves it.",
  guidance: {
    when: 'Sharing a captured tool orchestration you authored so other workspaces can install and run it.',
    notWhen:
      'Capturing or editing a recipe here (code:run captures automatically; recipes:*). Running one (recipes:run). Publishing a plan template (cupboard:publish-plan) or a rubric (cupboard:publish-rubric).',
    chaining:
      'recipes:search to find the id → cupboard:publish-recipe { id, exportOnly: true } → push the returned dir to a public mirror repo → cupboard:publish-recipe { id, githubUrl }. A localRefs refusal names exactly which scoped values block it.',
    seeAlso: [
      'cupboard:install-recipe (install a published recipe)',
      'recipes:search (find the recipe id to publish)',
      'cupboard:publish-plan (publish a plan template instead)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    id: z.string().min(1).max(LIMITS.IDENT).describe("The recipe's id in this workspace's recipe store."),
    githubUrl: z.string().max(500).optional().describe('The public mirror repo the exported dir lives in. Required unless exportOnly.'),
    exportOnly: z.boolean().optional().describe('Materialize the sanitized dir and STOP — no listing is created.'),
    listingRef: z.string().max(LIMITS.IDENT).optional().describe('Override the within-repo subdir / dir name (else the recipe id).'),
    projectRef: z.string().max(200).optional().describe('Papercupai project remote (owner/repo).'),
    title: hardText(LIMITS.SHORT_TITLE).optional().describe("Override the title (applies to the manifest AND the listing, so they cannot disagree)."),
    description: hardText(LIMITS.ANNOTATION).optional().describe('Override the description (manifest and listing alike).'),
    version: z.string().max(40).optional().describe('Version recorded in listing.json (storefront only).'),
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

    const { publishRecipeToCupboard } = await import('../../cupboard/publish-recipe-core');
    const result = await publishRecipeToCupboard({
      id: args.id,
      ...(args.githubUrl ? { github_url: args.githubUrl } : {}),
      ...(args.listingRef ? { listing_ref: args.listingRef } : {}),
      ...(args.projectRef ? { project_ref: args.projectRef } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.version ? { version: args.version } : {}),
      ...(args.exportOnly === true ? { exportOnly: true } : {}),
    });

    if (!result.ok) {
      return ok({
        ok: false,
        error: result.error,
        detail: result.detail,
        status: result.status,
        ...(result.localRefs ? { localRefs: result.localRefs } : {}),
        // Same refusal shape as the scoped-refs one above, for the same reason: a
        // script is not laundered. Name the hits so the fix is at the source.
        ...(result.identityLeaks
          ? {
              identityLeaks: result.identityLeaks,
              hint: 'NOTHING was written — publisher identity survived into the package bytes. A script is refused rather than rewritten, because a rewritten script RUNS differently from what its title claims. Generalize the recipe and re-capture it.',
            }
          : {}),
      });
    }

    const e = result.export;
    const common = {
      ref: e.written.ref,
      dir: e.written.dir,
      recipeId: e.id,
      title: e.title,
      toolsUsed: e.toolsUsed,
      authorityUnresolved: e.authorityUnresolved,
      strippedFields: e.strippedFields,
    };

    if (result.exportedOnly) {
      return ok({
        ok: true,
        exportedOnly: true,
        ...common,
        hint: `Sanitized recipe written to ${e.written.dir}. Push that directory to a public repo as <repo>/${e.written.ref}/, then re-run with githubUrl to create the listing.`,
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
          ? 'Published PENDING — an installed recipe is executable orchestration, so an operator must approve it before it is publicly visible (you can see your own listing meanwhile).'
          : undefined,
    });
  },
});
