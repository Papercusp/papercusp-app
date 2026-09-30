/**
 * cupboard:publish-datatype — the surface that RETIRES `datatypes:publish` (P-027 / D-010).
 *
 * The lifecycle is unchanged in substance: publish → PENDING operator moderation →
 * approved → globally visible → install. What changes is that it is now the ONE
 * Cupboard moderation queue instead of a second, parallel implementation of it — the
 * retired path could mark a datatype `pending` but nothing in the tree ever approved
 * it, so a published datatype could never become installable.
 *
 * `datatype` sits in REVIEW_POLICY_KINDS precisely so consolidation is not a silent
 * downgrade from moderated to auto-approved.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:publish-datatype',
  capability: 'harness:write',
  crossWorkspace: true,
  description:
    'Export one locally-declared datatype as datatype.json + listing.json and list it on the Cupboard. Marks it PENDING operator moderation; local usability is unchanged. Pass exportOnly to materialize the package before pushing it to the public mirror.',
  guidance: {
    when: 'Sharing a datatype you declared (meta:define-datatype) so other workspaces can install and use its kind.',
    notWhen:
      'Declaring a datatype (meta:define-datatype), or using one locally — a local datatype needs no publishing. Publishing does not distribute it by itself; approval and the Comb worker do.',
    chaining:
      "meta:define-datatype → cupboard:publish-datatype { datatypeId, githubUrl, exportOnly } → push the returned directory to the mirror → call again without exportOnly → (operator moderates) → consumers use cupboard:install-datatype.",
    seeAlso: [
      'cupboard:install-datatype (install a published datatype)',
      "cupboard:search { kind:'datatype' } (browse published datatypes)",
      'cupboard:unpublish',
    ],
  },
  args: z.object({
    datatypeId: z.string().min(1).max(120).describe('the local datatype id/slug to publish (from datatypes:list / datatypes:get)'),
    githubUrl: z.string().url().max(500).describe('the public GitHub mirror the package is pushed to'),
    listingRef: z.string().max(200).optional().describe('within-repo ref (default: the datatype id)'),
    projectRef: z.string().max(300).optional(),
    version: z.string().max(64).optional(),
    title: z.string().max(200).optional(),
    description: z.string().max(280).optional(),
    exportOnly: z.boolean().optional().describe('materialize the package directory without creating the listing'),
    workspace: entityRef('workspace', { max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    const workspaceId = args.workspace ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    if (!workspaceId) return ok({ ok: false, status: 400, error: 'no_workspace', detail: 'no workspace in the request context' });
    const [{ publishDatatypeToCupboard }, { writeDatatypePackageDir }, { fetchGithubRepoMeta }, { publishListingToCupboard }, { getOrgPg }, { listDatatypes }] =
      await Promise.all([
        import('../../cupboard/publish-datatype-core'),
        import('../../cupboard/datatype-store'),
        import('../../cupboard/resolve-repo-coords'),
        import('../../cupboard/publish-listing'),
        import('@papercusp/db-org'),
        import('../../datatype-registry-store'),
      ]);
    const result = await publishDatatypeToCupboard(
      {
        datatypeId: args.datatypeId,
        github_url: args.githubUrl,
        ...(args.listingRef ? { listing_ref: args.listingRef } : {}),
        ...(args.projectRef ? { project_ref: args.projectRef } : {}),
        ...(args.version ? { version: args.version } : {}),
        ...(args.title ? { title: args.title } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.exportOnly === true ? { exportOnly: true } : {}),
      },
      {
        // Resolution stays with the registry (D-010) — the publisher reads the row it
        // already has rather than re-deriving the definition.
        listDatatypes: () => listDatatypes(getOrgPg().sql, workspaceId),
        writePackage: writeDatatypePackageDir,
        fetchRepo: fetchGithubRepoMeta,
        publish: publishListingToCupboard,
      },
    );
    if (!result.ok) return ok({ ok: false, status: result.status, error: result.error, detail: result.detail });
    const listing = result.listing as { id?: string; review_status?: string } | undefined;
    return ok({
      ok: true,
      exportedOnly: result.exportedOnly,
      ref: result.export.ref,
      exportedTo: result.export.dir,
      listingId: listing?.id,
      review_status: listing?.review_status,
      hint: result.exportedOnly
        ? 'Push this self-describing directory to the matching path in the public mirror, then call again without exportOnly.'
        : 'Published — PENDING operator moderation. It stays usable locally; an operator approves it before it is globally installable.',
    });
  },
});
