/**
 * cupboard:publish-goal — list a goal PACKAGE on the Cupboard
 * (work-on-everything-goal-2026-08-23 P-006).
 *
 * The agent-callable face of `publishGoalToCupboard`. Like publish-plan, this
 * SERIALIZES first: a goal row fuses a reusable shape (title, duties body,
 * standing flag, rails, IO schemas) with live run state (status, spend,
 * tripwire readings, per-instance inputs, pause records). Publishing the live
 * half would ship this workspace's telemetry as someone else's starting point,
 * so it is stripped — and the response REPORTS what was stripped, because a
 * sanitizer nobody inspects is one nobody notices has stopped.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';

/** Canonical `{ data }` envelope — the framework owns wire encoding (auto-TOON on the MCP transport). */
const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:publish-goal',
  capability: 'harness:write',
  description:
    "List a goal package on the Cupboard. SERIALIZES the source goal first (status / inputs / metadata / tripwire `current` readings stripped; title, duties body, standing flag, kill criterion, tripwire thresholds, budget ceiling + window, launch settings and IO schemas kept), materializes it as a self-describing dir (goal.json + listing.json) under ~/.papercusp/goal-packages/<ref>/, then points a kind='goal' listing at the public mirror repo you pushed that dir to. Pass exportOnly to materialize the dir WITHOUT publishing (the honest order is export → push → publish). Goals are a reviewed kind — the publish lands PENDING until an operator approves it.",
  guidance: {
    when: 'Sharing a goal you run as a reusable package — its duties, rails and IO contract — so other workspaces can install it as an inactive stub and start it deliberately.',
    notWhen:
      'Creating or editing a goal here (goals:create / goals:update). Publishing a plan template (cupboard:publish-plan) or a rubric (cupboard:publish-rubric).',
    chaining:
      'cupboard:publish-goal { goalId, exportOnly: true } → push the returned dir to a public mirror repo → cupboard:publish-goal { goalId, githubUrl } to create the listing. Read `stripped` in the response to confirm the live state came out.',
    seeAlso: [
      'cupboard:install-goal (install a published goal package)',
      'cupboard:publish-plan (publish a plan template instead)',
      'cupboard:publish-rubric (publish a rubric a goal requires)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    goalId: z.string().min(1).max(LIMITS.IDENT).describe('The SOURCE goal id in this workspace — what gets serialized and published.'),
    harness: entityRef('harness', { soft: true, max: 120, describe: 'Narrow the lookup to a goal filed against this install_slug.' }).optional(),
    githubUrl: z
      .string()
      .max(500)
      .optional()
      .describe('The public mirror repo the exported dir lives in. Required unless exportOnly.'),
    exportOnly: z
      .boolean()
      .optional()
      .describe('Materialize the exported dir and STOP — no listing is created. Use this first, then push, then publish.'),
    listingRef: z.string().max(LIMITS.IDENT).optional().describe('Override the within-repo subdir / dir name (else derived from the goal title).'),
    projectRef: z.string().max(200).optional().describe('Papercupai project remote (owner/repo).'),
    title: hardText(LIMITS.SHORT_TITLE).optional().describe("Override the listing title (else the goal's title)."),
    description: hardText(LIMITS.ANNOTATION).optional().describe("Override the description (else the duty body's first line)."),
    version: z.string().max(40).optional().describe('Package version recorded in listing.json (storefront only).'),
    requiresRubrics: z
      .array(
        z.object({
          rubricRef: z.string().min(1).max(200),
          optional: z.boolean().optional(),
        }),
      )
      .max(50)
      .optional()
      .describe('Rubric requirements the package declares (a goal has no content to derive them from; omit for none).'),
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

    const { publishGoalToCupboard } = await import('../../cupboard/publish-goal-core');
    const result = await publishGoalToCupboard({
      goalId: args.goalId,
      ...(args.harness ? { harness: args.harness } : {}),
      ...(args.githubUrl ? { github_url: args.githubUrl } : {}),
      ...(args.listingRef ? { listing_ref: args.listingRef } : {}),
      ...(args.projectRef ? { project_ref: args.projectRef } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.version ? { version: args.version } : {}),
      ...(args.requiresRubrics ? { requires_rubrics: args.requiresRubrics } : {}),
      ...(args.exportOnly === true ? { exportOnly: true } : {}),
    });

    if (!result.ok) {
      return ok({
        ok: false,
        error: result.error,
        detail: result.detail,
        status: result.status,
        // A refused write names what leaked. Surfacing the hits is the whole value of
        // the gate to a caller: the dir was never created, so the only useful next
        // step is removing the identity at its source and re-exporting.
        ...(result.identityLeaks
          ? {
              identityLeaks: result.identityLeaks,
              hint: 'NOTHING was written — publisher identity survived into the package bytes. Identity in a duty body is prose, so it is refused rather than rewritten. Remove or parameterize the named values in the SOURCE goal, then re-run.',
            }
          : {}),
      });
    }

    const e = result.export;
    const common = {
      ref: e.written.ref,
      dir: e.written.dir,
      title: e.title,
      standing: e.standing,
      requiresRubrics: e.requiresRubrics,
      stripped: e.stripped,
    };

    if (result.exportedOnly) {
      return ok({
        ok: true,
        exportedOnly: true,
        ...common,
        hint: `Goal package written to ${e.written.dir}. Push that directory to a public repo as <repo>/${e.written.ref}/, then re-run with githubUrl to create the listing.`,
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
          ? 'Published PENDING — a goal package tells another workspace what to PURSUE and spend, so an operator must approve it before it is publicly visible (you can see your own listing meanwhile).'
          : undefined,
    });
  },
});
