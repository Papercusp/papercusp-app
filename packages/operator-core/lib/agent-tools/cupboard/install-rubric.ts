/**
 * cupboard:install-rubric — install a rubric from the Cupboard into this workspace
 * (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-004).
 *
 * The agent-callable face of `installRubricFromCupboard`: git-clone the listing's
 * mirror repo, validate <listingRef>/ as a self-describing rubric dir (rubric.json),
 * drop it into the writable user rubric layer (~/.papercusp/rubrics/<ref>/) where it
 * shadows the bundled first-party floor, then run the existing no-clobber seed so it
 * becomes a LIVE rubric row visible to rubrics:list/get and to scorecards.
 *
 * The two-step shape is deliberate and is the difference from install-template: a
 * rubric dir on disk is inert until seeded (a rubric IS a plan row with ratify/trend
 * machinery keyed off the DB), so `seeded` is reported explicitly rather than
 * assumed.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';

/** Canonical `{ data }` envelope — the framework owns wire encoding (auto-TOON on the MCP transport). */
const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:install-rubric',
  capability: 'harness:write',
  description:
    "Install a rubric from the Cupboard into this workspace: give a listingId (resolves the mirror repo + ref from the listing) OR a githubUrl + listingRef directly; the operator clones the mirror, validates <listingRef>/rubric.json, drops the dir into ~/.papercusp/rubrics/<ref>/ (shadowing the bundled floor), then seeds it into the workspace rubric store. NO-CLOBBER: a rubricId this workspace already owns always wins — an install never overwrites a locally-ratified rubric. Returns { ok, ref, rubricId, title, characteristic, seeded }.",
  guidance: {
    when: "Installing a published rubric so this workspace can grade against it — you found a rubric listing (cupboard:search kind='rubric') and want it available to scorecards:emit / acceptance grading.",
    notWhen:
      'Authoring a rubric here (rubrics:propose). Reading rubrics this workspace already has (rubrics:list / rubrics:get). Grading (scorecards:emit). Installing a plan template (cupboard:install-plan) or a template (cupboard:install-template).',
    chaining:
      "cupboard:search { kind:'rubric' } → cupboard:install-rubric { listingId } → rubrics:get { rubricRef } to confirm it is live → scorecards:emit against it. If `seeded` comes back false the dir is installed but not yet live — any later rubrics read retries the seed.",
    seeAlso: [
      'cupboard:search (find the rubric listing to install)',
      'rubrics:list (confirm what is live after installing)',
      'cupboard:publish-rubric (publish one of your own instead)',
    ],
  },
  args: z.object({
    listingId: z.string().max(200).optional().describe('The Cupboard listing id (or its listing_ref handle) — resolves the mirror repo URL + ref.'),
    githubUrl: z.string().max(500).optional().describe('Install a mirror repo directly instead of resolving a listing (needs listingRef).'),
    listingRef: z.string().max(200).optional().describe('Within-repo rubric discriminator (the per-ref subdir). Required with githubUrl; resolved from the listing when only listingId is given.'),
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
      kind: 'rubric',
      subject,
    });
    if (!gate.ok) {
      return ok({ ok: false, error: gate.code, detail: gate.detail, refusedBy: 'install-door-gate' });
    }

    const { installRubricFromCupboard } = await import('../../cupboard/install-rubric-io');
    const outcome = await installRubricFromCupboard({
      ...(args.listingId ? { listingId: args.listingId } : {}),
      ...(args.githubUrl ? { githubUrl: args.githubUrl } : {}),
      ...(args.listingRef ? { listingRef: args.listingRef } : {}),
    });

    if (!outcome.ok) {
      return ok({ ok: false, error: outcome.error, detail: outcome.detail, status: outcome.status });
    }
    const r = outcome.result;
    return ok({
      ok: true,
      ref: r.ref,
      rubricId: r.rubricId,
      title: r.title,
      characteristic: r.characteristic,
      version: r.version,
      hasMethod: r.hasMethod,
      installedTo: r.installedTo,
      seeded: r.seeded,
      ...(r.seedError ? { seedError: r.seedError } : {}),
      hint: r.seeded
        ? `Installed and live. Grade against it with scorecards:emit { rubricRef: "${r.rubricId}" }.`
        : 'Installed to disk but NOT yet seeded into the workspace store — it is not visible to rubrics:list/get yet. Any later rubrics read retries the seed; if it keeps failing, check the operator log for [rubrics].',
    });
  },
});
