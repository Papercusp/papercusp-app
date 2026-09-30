/**
 * cupboard:unpublish — withdraw (delist) a published Cupboard listing
 * (cupboard-agent-tool-coverage-2026-07-14 P-009).
 *
 * The agent-callable face of `deleteCupboardListing` — the SAME
 * DELETE /listings/:id primitive (gh-token authed, publisher-or-claimant) the
 * hive member-repo unlist uses (D-001 reuse-first). Universal across kinds:
 * plugin / pack / blueprint / template / app / knowledge-pack / harness are all
 * withdrawn by listing id. A whole HIVE (many member-repo rows at once) is
 * withdrawn via discovery:set_pot { visibility: 'private' }, which fans out over
 * this same primitive.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:unpublish',
  capability: 'harness:write',
  description:
    "Withdraw (delist) a published Cupboard listing by its listing id — the DELETE /listings/:id primitive, authed with the operator's gh token (the worker enforces publisher-or-claimant). Universal across kinds (plugin/pack/blueprint/template/app/knowledge-pack/harness). Idempotent: re-delisting an already-unlisted listing reports alreadyUnlisted, not an error.",
  guidance: {
    when: "Taking down a listing you published to the Cupboard (any single kind), by its listing id.",
    notWhen:
      "Withdrawing a WHOLE hive (all its member-repo listings at once) — use discovery:set_pot { visibility: 'private' }, which unlists them AND stops the P2P re-announce. Operator MODERATION takedown of someone else's listing is a separate admin path (/cupboard/admin).",
    chaining:
      'Find the listing id first (cupboard:search). The worker enforces publisher/claimant permission — a 403 means this gh identity does not own/claim the listing.',
    seeAlso: [
      'cupboard:search (find the listing id to unpublish)',
      'discovery:set_pot (withdraw a whole hive: visibility:private)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    listingId: z.string().min(1).max(200).describe('The Cupboard listing id to delist (from cupboard:search).'),
  }),
  async handler(args) {
    const { deleteCupboardListing } = await import('../../cupboard/delete-listing');
    const res = await deleteCupboardListing(args.listingId);
    if (!res.ok) {
      return text({ ok: false, error: res.error, status: res.status });
    }
    return text({
      ok: true,
      listingId: args.listingId,
      alreadyUnlisted: res.alreadyUnlisted === true,
      hint: res.alreadyUnlisted
        ? 'Listing was already unlisted (idempotent).'
        : 'Listing withdrawn from the Cupboard.',
    });
  },
});
