/**
 * User profile read endpoint — Phase 8 P-072.
 *
 *   GET /api/users/github/:id
 *   query: ?limit_activity=N (default 30, capped at 100)
 *
 * Returns UserProfileData for the numeric github_user_id. Wraps
 * loadUserProfile + loadUserRecentActivity (which is called inside
 * loadUserProfile, so the activity field comes for free).
 *
 * viewer_github_user_id is resolved from the session via
 * getSessionUserOrDefault so the privacy filter (Q-2) reflects who
 * is actually viewing the profile, not just the API caller.
 *
 * Public route — no auth required (P-072 marketplace publishedBy
 * deep-link is a use case). Privacy filter limits what shared-private
 * harness rows leak.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-072.
 */

import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/agent-mcp';
import { loadUserProfile } from '../../../user-profile/load';
import { getSessionUserOrDefault } from '../../../auth';
import { resolveLocalGithubIdentity } from '../../../identity/resolve-local-github-identity';

/**
 * Resolve the viewing user's github id for the §18 privacy filter.
 *
 * Two sources, in order: (1) a web/multi-user session via
 * `getSessionUserOrDefault`; (2) — the desktop case — the LOCAL machine's
 * GitHub identity (`resolveLocalGithubIdentity`), which IS the viewer on a
 * single-user, loopback-bound desktop. Before the local fallback the desktop
 * always resolved to `null` → anonymous → public-only profiles, which is the
 * P-072 "viewer-identity infra" gap this closes. Returns `null` (anonymous,
 * public-only) when neither source yields an id — never throws.
 */
async function viewerGithubUserId(): Promise<number | null> {
  try {
    const user = await getSessionUserOrDefault();
    const ghId = (user as { github_user_id?: number | string | null })?.github_user_id;
    if (typeof ghId === 'number' && Number.isFinite(ghId)) return ghId;
    if (typeof ghId === 'string') {
      const parsed = Number.parseInt(ghId, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch {
    /* fall through to the local-identity resolver */
  }
  try {
    const local = await resolveLocalGithubIdentity();
    if (local.kind === 'ok') return local.githubUserId;
  } catch {
    /* no gh auth → anonymous */
  }
  return null;
}

const get = defineTool({
  method: 'GET',
  path: '/users/github/:id',
  auth: 'public',
  async handler(_req, ctx) {
    const idParam = ctx.params.id as string;
    const numericId = Number.parseInt(idParam, 10);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return Response.json(
        { error: 'invalid id', id: idParam },
        { status: 400 },
      );
    }
    const viewerId = await viewerGithubUserId();
    const { sql } = getOrgPg();
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    const profile = await loadUserProfile({
      github_user_id: numericId,
      viewer_github_user_id: viewerId,
      runQuery,
    });
    return Response.json({ profile });
  },
});

export default [get];
