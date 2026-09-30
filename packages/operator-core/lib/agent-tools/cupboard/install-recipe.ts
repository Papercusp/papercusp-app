/**
 * cupboard:install-recipe — install a recipe from the Cupboard into this workspace
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-014).
 *
 * The agent-callable face of `installRecipeFromCupboard`: clone the mirror, validate
 * `<listingRef>/recipe.json`, drop the dir into `~/.papercusp/recipes/<ref>/`, then
 * seed a `code_recipes` row so the recipe is visible to recipes:search / recipes:run.
 * A dir alone is inert — recipes resolve from Postgres, never from the store — which
 * is why `seeded` is reported explicitly rather than assumed.
 *
 * NO-CLOBBER on the recipe id, and worth stating because the underlying store write
 * is an UPSERT: an existing local recipe of that id is never overwritten with a
 * stranger's script.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';

/** Canonical `{ data }` envelope — the framework owns wire encoding (auto-TOON on the MCP transport). */
const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:install-recipe',
  capability: 'harness:write',
  description:
    "Install a recipe from the Cupboard into this workspace: give a listingId (resolves the mirror repo + ref from the listing) OR a githubUrl + listingRef directly; the operator clones the mirror, validates <listingRef>/recipe.json, drops the dir into ~/.papercusp/recipes/<ref>/, then seeds a code_recipes row so recipes:search / recipes:get / recipes:run can see it. NO-CLOBBER: an existing recipe of that id is never overwritten. Returns { ok, ref, recipeId, title, toolsUsed, authorityUnresolved, seeded }.",
  guidance: {
    when: "Installing a published recipe so this workspace can run it — you found a recipe listing (cupboard:search kind='recipe') and want the orchestration locally.",
    notWhen:
      'Capturing a recipe here (code:run captures automatically). Finding recipes this workspace already has (recipes:search). Installing a plan template (cupboard:install-plan) or a rubric (cupboard:install-rubric).',
    chaining:
      "cupboard:search { kind:'recipe' } → cupboard:install-recipe { listingId } → recipes:get { id: recipeId } to read the script BEFORE recipes:run. Read `authorityUnresolved` first: true means the publisher's analyzer could not prove the script's effects statically, so read it before running it.",
    seeAlso: [
      'cupboard:search (find the recipe listing to install)',
      'recipes:run (run it once installed)',
      'cupboard:publish-recipe (publish one of your own instead)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe('The Cupboard listing id (or its listing_ref handle) — resolves the mirror repo URL + ref.'),
    githubUrl: z.string().max(500).optional().describe('Install a mirror repo directly instead of resolving a listing (needs listingRef).'),
    listingRef: z.string().max(200).optional().describe('Within-repo recipe discriminator (the per-ref subdir). Required with githubUrl.'),
    skipSeed: z.boolean().optional().describe('Place the dir only — do not create the code_recipes row.'),
    workspace: entityRef('workspace', { max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    const subject = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();

    if (!args.listingId && !args.githubUrl) {
      return ok({ ok: false, error: 'listingId or githubUrl required' });
    }

    // D-045 §3a — the release chain decides BEFORE any bytes move.
    const { gateInstallDoor } = await import('../../cupboard/install-door-gate-io');
    const gate = await gateInstallDoor({
      idOrRef: args.listingId ?? args.listingRef,
      kind: 'recipe',
      subject,
    });
    if (!gate.ok) {
      return ok({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    }

    const { installRecipeFromCupboard } = await import('../../cupboard/install-recipe-io');
    const outcome = await installRecipeFromCupboard({
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
      ...(args.skipSeed === true ? { skipSeed: true } : {}),
    });

    if (!outcome.ok) {
      return ok({ ok: false, error: outcome.error, detail: outcome.detail, status: outcome.status });
    }
    const r = outcome.result;
    return ok({
      ok: true,
      ref: r.ref,
      recipeId: r.recipeId,
      title: r.title,
      toolsUsed: r.toolsUsed,
      tags: r.tags,
      authorityUnresolved: r.authorityUnresolved,
      installedTo: r.installedTo,
      seeded: r.seeded,
      ...(r.seedSkipped ? { seedSkipped: r.seedSkipped } : {}),
      hint: r.seeded
        ? `Installed and live. Read it first with recipes:get { id: "${r.recipeId}" }${r.authorityUnresolved ? ' — its effects could not be proven statically' : ''}, then recipes:run.`
        : r.seedSkipped === 'exists'
          ? `Dir installed, but a recipe "${r.recipeId}" already exists here and was NOT overwritten.`
          : 'Dir installed but no recipe row was seeded — see seedSkipped; it is not visible to recipes:search yet.',
    });
  },
});
