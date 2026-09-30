/**
 * cupboard:install-plan — install a plan TEMPLATE from the Cupboard into this
 * workspace (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-010 + P-011).
 *
 * The agent-callable face of `installPlanFromCupboard`. Three things distinguish it
 * from the other install verbs, and each is worth knowing before calling it:
 *
 *  - It GATES on the listing's `requires_rubrics` BEFORE downloading anything. A plan
 *    template whose acceptance rubric this workspace cannot grade against would
 *    install cleanly and then fail at its ship gate much later, somewhere that never
 *    mentions the install. A required rubric nothing provides REFUSES; one a Cupboard
 *    listing provides is offered as a co-install (`installRequiredRubrics: true`).
 *    The BUNDLED first-party rubric set counts as provided, so the plan-class rubrics
 *    most templates derive normally need nothing.
 *  - It lands a plan TEMPLATE, never live work: the seeded row is `status: draft`, so
 *    it carries no claimable items into the scheduler and mints no work-items.
 *  - It is NO-CLOBBER on the plan slug: an existing plan of that slug always wins.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';

/** Canonical `{ data }` envelope — the framework owns wire encoding (auto-TOON on the MCP transport). */
const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:install-plan',
  capability: 'harness:write',
  description:
    "Install a plan template from the Cupboard into this workspace: give a listingId (resolves the mirror repo + ref + rubric requirements from the listing) OR a githubUrl + listingRef directly. RESOLVES requires_rubrics FIRST — a required rubric nothing provides refuses the install; one a Cupboard rubric listing provides is offered as a co-install (pass installRequiredRubrics: true to accept); the bundled first-party rubric set counts as provided. Then clones the mirror, validates <listingRef>/plan.md parses as a structured plan, drops the dir into ~/.papercusp/plan-templates/<ref>/, and seeds a status:'draft' plan TEMPLATE row. NO-CLOBBER: an existing plan of that slug always wins. Returns { ok, ref, templateSlug, rubrics, coInstalled, seeded }.",
  guidance: {
    when: "Installing a published plan template so this workspace can instantiate it — you found a plan listing (cupboard:search kind='plan') and want its goal/item-DAG/decisions locally.",
    notWhen:
      'Authoring a plan here (plans:new). Reading plans this workspace already has (plans:list / plans:get). Installing a rubric (cupboard:install-rubric) or an app template (cupboard:install-template).',
    chaining:
      "cupboard:search { kind:'plan' } → cupboard:install-plan { listingId } → plans:get { slug: templateSlug } to read it → plans:start when you actually want to run it. A `required_rubrics_need_co_install` refusal names the rubrics; re-run with installRequiredRubrics: true to pull them in.",
    seeAlso: [
      'cupboard:search (find the plan listing to install)',
      'cupboard:install-rubric (install one required rubric by hand instead)',
      'cupboard:publish-plan (publish one of your own instead)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe('The Cupboard listing id (or its listing_ref handle) — resolves the mirror repo URL, ref and requires_rubrics.'),
    githubUrl: z.string().max(500).optional().describe('Install a mirror repo directly instead of resolving a listing (needs listingRef; no requires_rubrics is then known).'),
    listingRef: z.string().max(200).optional().describe('Within-repo plan-template discriminator (the per-ref subdir). Required with githubUrl; resolved from the listing when only listingId is given.'),
    installRequiredRubrics: z
      .boolean()
      .optional()
      .describe('Accept the co-install of required rubrics this workspace lacks. Without it a resolvable-but-missing requirement refuses rather than silently pulling in extra units.'),
    harness: entityRef('harness', { soft: true, max: 120, describe: 'Harness scope for the seeded plan row.' }).optional(),
    skipSeed: z.boolean().optional().describe('Place the dir only — do not create the plan row.'),
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
      kind: 'plan',
      subject,
    });
    if (!gate.ok) {
      return ok({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    }

    const { installPlanFromCupboard } = await import('../../cupboard/install-plan-io');
    const outcome = await installPlanFromCupboard({
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
      ...(args.installRequiredRubrics === true ? { installRequiredRubrics: true } : {}),
      ...(args.harness ? { harness: args.harness } : {}),
      ...(args.skipSeed === true ? { skipSeed: true } : {}),
    });

    if (!outcome.ok) {
      return ok({
        ok: false,
        error: outcome.error,
        detail: outcome.detail,
        status: outcome.status,
        ...(outcome.rubrics ? { rubrics: outcome.rubrics } : {}),
      });
    }
    const r = outcome.result;
    return ok({
      ok: true,
      ref: r.ref,
      templateSlug: r.templateSlug,
      title: r.title,
      itemCount: r.itemCount,
      decisionCount: r.decisionCount,
      requiresRubrics: r.requiresRubrics,
      rubrics: { satisfied: r.rubrics.satisfied, missingOptional: r.rubrics.missingOptional },
      coInstalled: r.coInstalled,
      installedTo: r.installedTo,
      seeded: r.seeded,
      ...(r.seedSkipped ? { seedSkipped: r.seedSkipped } : {}),
      hint: r.seeded
        ? `Installed as a DRAFT plan template. Read it with plans:get { slug: "${r.templateSlug}" }; it carries no claimable items until you start it.`
        : r.seedSkipped === 'exists'
          ? `Dir installed, but a plan "${r.templateSlug}" already exists here and was NOT overwritten. Read the existing one, or re-install under a different slug.`
          : 'Dir installed but no plan row was seeded — see seedSkipped.',
    });
  },
});
