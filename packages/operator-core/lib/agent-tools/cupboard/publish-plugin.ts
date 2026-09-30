/**
 * cupboard:publish-plugin — list an installed distribution unit (a plugin OR a
 * runtime-less code-tool pack) on the Cupboard (cupboard-agent-tool-coverage-
 * 2026-07-14 P-001 / P-004).
 *
 * The agent-callable face of `publishInstalledUnitToCupboard` — the SAME core
 * the loopback POST /cupboard/publish-plugin route calls (D-001 reuse-first, no
 * fork). The listing kind auto-follows the installed manifest's `kind` ('pack' →
 * kind=pack, else plugin), so ONE tool covers both P-001 (plugin) and P-004
 * (pack): the user asks "publish my plugin/pack" and the manifest decides.
 *
 * Mirrors blueprint:publish / knowledge_packs:publish / cupboard:publish-app:
 * resolve GitHub coords + publish through the shared publish core (gh token +
 * attestation); a plugin listing lands after the install-ability gate, and (like
 * every reviewed kind) is subject to the worker's review policy.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { activeWorkspaceId } from '../../workspace-registry';

// { data } shape: the framework owns wire encoding (tool-data-shape ratchet, WI-10002555).
const text = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:publish-plugin',
  capability: 'harness:write',
  description:
    "List an installed distribution unit — a plugin OR a runtime-less code-tool pack — on the Cupboard: resolves the unit repo's GitHub coords (explicit githubUrl, else the installed unit's git origin) + publishes a kind='plugin' (or kind='pack', auto-detected from the manifest) listing with the operator's gh token + attestation. Derives the unit's provided tools + event families from its manifest so tool→provider discovery resolves, and (for plugins) gates on install-ability so a listing can't point at a repo the installer can't resolve. Title/description default from the manifest.",
  guidance: {
    when: "Sharing a plugin or code-tool pack you have INSTALLED (its manifest name is the slug), so others can install it from the Cupboard — one tool for both (the manifest's kind decides plugin vs pack).",
    notWhen:
      "Publishing a blueprint (blueprint:publish), a knowledge pack (knowledge_packs:publish), a whole standalone app (cupboard:publish-app), or an app-template (cupboard:publish-template). If the unit is not installed locally, pass githubUrl pointing at its repo; either way the code must be pushed to GitHub first.",
    chaining:
      'Publish points at the GitHub repo, so commit + push the unit first. The response carries the listing + its review_status — a reviewed kind lands PENDING until an operator approves it at /admin/cupboard-moderation.',
    seeAlso: [
      'cupboard:publish-template (publish an app-template instead)',
      'blueprint:publish (publish a blueprint instead)',
      'knowledge_packs:publish (publish a knowledge pack instead)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    slug: z
      .string()
      .min(1)
      .max(LIMITS.IDENT)
      .describe(
        "The installed unit's manifest name (its listing_ref unless overridden). Its listing kind auto-follows the manifest: kind:'pack' → a pack listing, else a plugin listing.",
      ),
    githubUrl: z
      .string()
      .max(500)
      .optional()
      .describe("Override the repo the listing points at (else resolved from the installed unit's git origin). Required if the unit is not installed locally."),
    listingRef: z
      .string()
      .max(LIMITS.IDENT)
      .optional()
      .describe('Override the within-repo listing ref (else the slug).'),
    projectRef: z.string().max(200).optional().describe('Papercupai project remote (owner/repo).'),
    title: hardText(LIMITS.SHORT_TITLE).optional().describe('Override the listing title (else the manifest name).'),
    description: hardText(LIMITS.ANNOTATION).optional().describe('Override the listing description (else the manifest description).'),
    providesTools: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(200)
      .optional()
      .describe('Override the declared MCP tool names (else derived from the manifest).'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    void (args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId());

    const { publishInstalledUnitToCupboard } = await import('../../cupboard/publish-plugin-core');
    const result = await publishInstalledUnitToCupboard({
      slug: args.slug,
      ...(args.githubUrl ? { github_url: args.githubUrl } : {}),
      ...(args.listingRef ? { listing_ref: args.listingRef } : {}),
      ...(args.projectRef ? { project_ref: args.projectRef } : {}),
      ...(args.title ? { title: args.title } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.providesTools ? { provides_tools: args.providesTools } : {}),
    });

    if (!result.ok) {
      return text({ ok: false, error: result.error, detail: result.detail, status: result.status });
    }
    const data = result.listing as { id?: string; review_status?: string; pending_review?: boolean };
    return text({
      ok: true,
      listingId: data.id,
      listingKind: result.listing_kind,
      review_status: data.review_status ?? 'pending',
      hint:
        data.review_status === 'pending' || data.pending_review
          ? 'Published PENDING — an operator must approve it before it is publicly visible (you can watch your own listing meanwhile).'
          : undefined,
    });
  },
});
