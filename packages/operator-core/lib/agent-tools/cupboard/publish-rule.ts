/**
 * cupboard:publish-rule — list a rule package on the Cupboard
 * (portable-identity-packages-2026-09-26 P-011, D-023 §6 — the D-055 gap).
 *
 * The agent-callable face of `publishRuleToCupboard`. A rule listing is
 * mirror-repo-backed like a rubric: it points at the public repo the rule's
 * self-describing dir (rule.json + listing.json) was pushed to, with listing_ref =
 * the per-rule subdir. The local rule must parse, so a malformed manifest is never
 * advertised. Rules are a reviewed kind — every publish lands PENDING.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';

/** Canonical `{ data }` envelope — the framework owns wire encoding (auto-TOON on the MCP transport). */
const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:publish-rule',
  capability: 'harness:write',
  description:
    "List a rule package on the Cupboard: points a kind='rule' listing at the public mirror repo the rule's self-describing dir (rule.json + listing.json) was pushed to, with listing_ref = the per-rule subdir. The local rule must parse. Rules are a reviewed kind — the publish lands PENDING until an operator approves it.",
  guidance: {
    when: 'Sharing a sync hook rule or async reaction rule you authored so other workspaces can pin it in a blueprint — after its dir is pushed to a public mirror repo.',
    notWhen:
      'Publishing a rubric (cupboard:publish-rubric) or an event listing (cupboard:publish-event).',
    chaining:
      'Push the rule dir to its public mirror repo first (githubUrl points there). The response carries review_status — PENDING until an operator approves it at /admin/cupboard-moderation.',
    seeAlso: [
      'cupboard:install-rule (install a published rule into this workspace)',
      'cupboard:publish-event (publish an event listing instead)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    ref: z
      .string()
      .min(1)
      .max(LIMITS.IDENT)
      .describe("The rule's local ref or id (defaults title+description; also the default listing_ref)."),
    githubUrl: z
      .string()
      .min(1)
      .max(500)
      .describe('REQUIRED — the public mirror repo the rule dir lives in.'),
    listingRef: z.string().max(LIMITS.IDENT).optional().describe('Override the within-repo subdir (else `ref`).'),
    projectRef: z.string().max(200).optional().describe('Papercupai project remote (owner/repo).'),
    title: hardText(LIMITS.SHORT_TITLE).optional().describe('Override the listing title (else the local rule title).'),
    description: hardText(LIMITS.ANNOTATION).optional().describe('Override the listing description (else the local rule description).'),
    workspace: entityRef('workspace', { max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    void (args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId());

    const { publishRuleToCupboard } = await import('../../cupboard/publish-rule-core');
    const result = await publishRuleToCupboard({
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
          ? 'Published PENDING — a rule actuates in every pot that pins it, so an operator must approve it before it is publicly visible (you can see your own listing meanwhile).'
          : undefined,
    });
  },
});
