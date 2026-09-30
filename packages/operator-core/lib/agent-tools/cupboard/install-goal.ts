/**
 * cupboard:install-goal — install a goal PACKAGE from the Cupboard into this
 * workspace as an INACTIVE stub (work-on-everything-goal-2026-08-23 P-006,
 * D-002: install ≠ start).
 *
 * The agent-callable face of `installGoalFromCupboard`. What distinguishes it:
 *
 *  - It GATES on `harness` FIRST (a goal is filed against an install_slug) and
 *    on the listing's `requires_rubrics` BEFORE downloading anything — same
 *    refusal-at-the-moment-of-choice ordering as cupboard:install-plan.
 *  - It lands an INACTIVE STUB, never live work: the seeded goal is
 *    status:'paused' with a pause record naming this installer, no agent is
 *    minted, nothing is spawned, no spend can accrue. Starting it is a
 *    separate deliberate act.
 *  - It is NO-CLOBBER on PACKAGE IDENTITY: any existing goal stamped with this
 *    package's ref (whatever its status) wins over a re-install.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';

/** Canonical `{ data }` envelope — the framework owns wire encoding (auto-TOON on the MCP transport). */
const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:install-goal',
  capability: 'harness:write',
  description:
    "Install a goal package from the Cupboard as an INACTIVE stub: give a listingId (resolves the mirror repo + ref + rubric requirements from the listing) OR a githubUrl + listingRef directly. Requires `harness` (the install_slug the stub is filed against) unless skipSeed. RESOLVES requires_rubrics FIRST — a required rubric nothing provides refuses the install; one a Cupboard rubric listing provides is offered as a co-install (pass installRequiredRubrics: true). Then clones the mirror, validates <listingRef>/goal.json, drops the dir into ~/.papercusp/goal-packages/<ref>/, and seeds a status:'paused' goal stub — NO agent, NO spend; starting it is a separate deliberate act. NO-CLOBBER on package identity: an existing goal from this package always wins.",
  guidance: {
    when: "Installing a published goal package so this workspace can run its duty — you found a goal listing (cupboard:search kind='goal') and want its shape (duties, rails, IO contract) locally as a stub you start deliberately.",
    notWhen:
      'Creating a goal from scratch (goals:create). Starting a goal (a separate deliberate act — the stub stays paused). Installing a plan template (cupboard:install-plan) or a rubric (cupboard:install-rubric).',
    chaining:
      "cupboard:search { kind:'goal' } → cupboard:install-goal { listingId, harness } → goals:get { id: goalId } to read the stub → start it deliberately when you actually want it pursued. A `required_rubrics_need_co_install` refusal names the rubrics; re-run with installRequiredRubrics: true to pull them in.",
    seeAlso: [
      'cupboard:search (find the goal listing to install)',
      'cupboard:install-rubric (install one required rubric by hand instead)',
      'cupboard:publish-goal (publish one of your own instead)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe('The Cupboard listing id (or its listing_ref handle) — resolves the mirror repo URL, ref and requires_rubrics.'),
    githubUrl: z.string().max(500).optional().describe('Install a mirror repo directly instead of resolving a listing (needs listingRef; no requires_rubrics is then known).'),
    listingRef: z.string().max(200).optional().describe('Within-repo goal-package discriminator (the per-ref subdir). Required with githubUrl; resolved from the listing when only listingId is given.'),
    installRequiredRubrics: z
      .boolean()
      .optional()
      .describe('Accept the co-install of required rubrics this workspace lacks. Without it a resolvable-but-missing requirement refuses rather than silently pulling in extra units.'),
    harness: entityRef('harness', { soft: true, max: 120, describe: 'The install_slug the goal stub is filed against. REQUIRED unless skipSeed.' }).optional(),
    skipSeed: z.boolean().optional().describe('Place the dir only — do not create the goal stub.'),
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
      kind: 'goal',
      subject,
    });
    if (!gate.ok) {
      return ok({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    }

    const { installGoalFromCupboard } = await import('../../cupboard/install-goal-io');
    const outcome = await installGoalFromCupboard({
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
      title: r.pkg.title,
      standing: r.pkg.standing,
      requiresRubrics: r.pkg.requiresRubrics,
      rubrics: { satisfied: r.rubrics.satisfied, missingOptional: r.rubrics.missingOptional },
      coInstalled: r.coInstalled,
      installedTo: r.installedTo,
      seeded: r.seeded,
      ...(r.goalId ? { goalId: r.goalId } : {}),
      ...(r.seedSkipped ? { seedSkipped: r.seedSkipped } : {}),
      hint: r.seeded
        ? `Installed as an INACTIVE goal stub (status 'paused' — no agent, no spend). Read it with goals:get { id: "${r.goalId}" }; starting it is a separate deliberate act.`
        : r.seedSkipped === 'exists'
          ? `Dir installed, but a goal from package "${r.ref}" already exists in this workspace (any status counts) and was NOT overwritten.`
          : 'Dir installed but no goal stub was seeded — see seedSkipped.',
    });
  },
});
