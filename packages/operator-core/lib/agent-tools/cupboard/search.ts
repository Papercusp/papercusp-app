/**
 * cupboard:search — browse/search the public Cupboard storefront across every
 * listing kind (cupboard-agent-tool-coverage-2026-07-14 P-008).
 *
 * The one agent-callable BROWSE surface for the Cupboard: wraps the typed
 * `browseCupboardListings` read of the worker's generalized /listings surface
 * (kind-aware). Returns a compact per-listing projection (id / kind / ref / title
 * / description / repo) so an agent can find something to install without pulling
 * full rows into context. Kind-specific browsers still exist (blueprint:catalog,
 * knowledge_packs:list, templates:list) — this is the cross-kind one.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { LISTING_KINDS } from '../../cupboard/types';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/** Compact a raw worker listing row to the fields an agent needs to choose + act. */
function project(row: Record<string, unknown>): Record<string, unknown> {
  const pick = (k: string) => (typeof row[k] === 'string' || typeof row[k] === 'number' ? row[k] : undefined);
  const desc = typeof row.description === 'string' ? row.description : undefined;
  return {
    id: pick('id'),
    kind: pick('listing_kind'),
    ref: pick('listing_ref'),
    title: pick('title'),
    description: desc && desc.length > 240 ? `${desc.slice(0, 240)}…` : desc,
    github_url: pick('github_url'),
    ...(pick('review_status') ? { review_status: pick('review_status') } : {}),
  };
}

export default defineTool({
  name: 'cupboard:search',
  capability: 'harness:read',
  description:
    "Browse/search the public Cupboard storefront across every listing kind (harness · blueprint · plugin · pack · knowledge-pack · template · app · plan · rubric · recipe · goal · theme). Filter by kind, free-text q, or project (owner/repo); paginate with cursor. Returns a compact per-listing projection (id · kind · ref · title · description · github_url) — use the id with the matching kind-specific installer.",
  guidance: {
    when: "Finding what's available on the public Cupboard — the user asks what plugins/blueprints/templates/apps/packs exist, or wants to search for one to install.",
    notWhen:
      "You already have a listing id and want to INSTALL it (cupboard:install-plugin / cupboard:install-blueprint / templates:new-app / knowledge_packs:install). For the kind-specific browse UIs, blueprint:catalog / knowledge_packs:list / templates:list are narrower views of the same store.",
    chaining:
      'Search → take a result id → install with the matching installer (cupboard:install-plugin for plugin/pack, cupboard:install-blueprint for blueprint, templates:new-app for template, knowledge_packs:install for a knowledge-pack).',
    seeAlso: [
      'cupboard:install-plugin (install a plugin/pack result)',
      'cupboard:install-blueprint (install a blueprint result)',
      'blueprint:catalog (kind-specific blueprint browse)',
    ],
  },
  args: z.object({
    kind: z
      .enum([...LISTING_KINDS, 'all'] as unknown as [string, ...string[]])
      .optional()
      .describe('Restrict to one listing kind, or "all" (default: all kinds).'),
    q: z.string().max(200).optional().describe('Free-text search across the storefront.'),
    project: z.string().max(200).optional().describe('Filter to a project_ref (owner/repo).'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size (default 50).'),
    cursor: z.string().max(500).optional().describe('Pagination cursor from a prior page\'s nextCursor.'),
  }),
  async handler(args) {
    const { browseCupboardListings } = await import('../../cupboard/browse-listings');
    const result = await browseCupboardListings({
      ...(args.kind ? { kind: args.kind as never } : {}),
      ...(args.q ? { q: args.q } : {}),
      ...(args.project ? { project: args.project } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    if (!result.ok) {
      return text({ ok: false, error: result.error, status: result.status });
    }
    return text({
      ok: true,
      count: result.listings.length,
      listings: result.listings.map(project),
      ...(result.total !== undefined ? { total: result.total } : {}),
      ...(result.kind_facets ? { kindFacets: result.kind_facets } : {}),
      ...(result.next_cursor ? { nextCursor: result.next_cursor } : {}),
    });
  },
});
