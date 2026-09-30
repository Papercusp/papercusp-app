/**
 * cupboard:publish-event — publish a locally-registered event key as a Cupboard listing.
 *
 * The publish half of identities-v1-2026-08-30 P-029 (D-010/D-011). It closes a gap
 * that has been live since the Cupboard's first release: `requires_events` already
 * lets a listing depend on an event family — and an unresolvable dependency is a hard
 * install failure — but only FIRST-PARTY families could ever resolve, because nothing
 * could publish one.
 *
 * `event` is in REVIEW_POLICY_KINDS, so this publishes PENDING: an event vocabulary is
 * moderated like every other kind rather than auto-approved into the namespace.
 *
 * The definition resolves from `event_key_registry` (D-010) — this reads the row it
 * already has and exports it. It never becomes a second source of truth, and it never
 * registers anything; seeding a row is the install seam's job.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:publish-event',
  capability: 'harness:write',
  crossWorkspace: true,
  description:
    'Export one locally-registered event key as event.json + listing.json and list it on the Cupboard. Marks it PENDING operator moderation; local resolution is unchanged. Pass exportOnly to materialize the package before pushing it to the public mirror.',
  guidance: {
    when: 'Sharing an event vocabulary you registered so other workspaces can install it and have its key resolve — and so their listings can declare requires_events on it.',
    notWhen:
      'Registering a key locally, or emitting one — a first-party key needs no publishing. Publishing does not distribute it by itself; approval and the Comb worker do.',
    chaining:
      'register the key → cupboard:publish-event { eventKey, githubUrl, exportOnly } → push the returned directory to the mirror → call again without exportOnly → (operator moderates) → consumers use cupboard:install-event.',
    seeAlso: [
      'cupboard:install-event (install a published event vocabulary)',
      "cupboard:search { kind:'event' } (browse published event keys)",
      'events:catalog (what this workspace already resolves)',
    ],
  },
  args: z.object({
    eventKey: z.string().min(1).max(200).describe('the locally-registered event key to publish (from events:catalog)'),
    githubUrl: z.string().url().max(500).describe('the public GitHub mirror the package is pushed to'),
    listingRef: z.string().max(200).optional().describe('within-repo ref (default: the event key)'),
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
    const [{ publishEventToCupboard }, { writeEventPackageDir }, { fetchGithubRepoMeta }, { publishListingToCupboard }, { getOrgPg }, { listEventKeys }] =
      await Promise.all([
        import('../../cupboard/publish-event-core'),
        import('../../cupboard/event-store'),
        import('../../cupboard/resolve-repo-coords'),
        import('../../cupboard/publish-listing'),
        import('@papercusp/db-org'),
        import('../../event-key-registry-store'),
      ]);
    const result = await publishEventToCupboard(
      {
        eventKey: args.eventKey,
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
        // already has rather than re-deriving the definition from a scan.
        listEventKeys: () => listEventKeys(getOrgPg().sql, workspaceId),
        writePackage: writeEventPackageDir,
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
        : 'Published — PENDING operator moderation. The key stays resolvable locally; an operator approves it before it is globally installable.',
    });
  },
});
