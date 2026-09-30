/**
 * Harness contributor-usage — per-kind activity rollup for one contributor.
 *
 *   GET /api/harness/:slug/contributor-usage?github_user_id=<id>
 *
 * Wraps `rollupForContributor` (P-070b): a single GROUP-BY over
 * `harness_shared.contributor_usage_events` → per-kind counts + total +
 * last-event timestamp. The Contributors tab's flat "N act" badge comes from a
 * cheap inline COUNT in /contributors; THIS endpoint backs the per-kind
 * breakdown shown when a contributor row is expanded (the v5 §9.2 "23 features
 * shipped"-style detail), fetched on demand so the list query stays a single
 * aggregate.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-070b.
 */
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { rollupForContributor } from '../../../harness/usage-events';

export type ParsedGithubUserId =
  | { ok: true; github_user_id: number }
  | { ok: false; error: string };

/** Pure: parse + validate the `github_user_id` query param. Exported for tests. */
export function parseGithubUserIdParam(raw: string | null): ParsedGithubUserId {
  if (raw == null || raw.trim() === '') {
    return { ok: false, error: 'github_user_id required' };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: 'github_user_id must be a positive integer' };
  }
  return { ok: true, github_user_id: n };
}

const usage = defineTool({
  method: 'GET',
  path: '/harness/:slug/contributor-usage',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const parsed = parseGithubUserIdParam(url.searchParams.get('github_user_id'));
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const { sql } = getOrgPg();
    const rollup = await rollupForContributor(parsed.github_user_id, slug, { sql });
    return Response.json({ rollup });
  },
});

export default [usage];
