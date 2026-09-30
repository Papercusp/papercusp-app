/**
 * Harness Insights — JSON endpoint for Phase 8 P-073.
 *
 *   GET /api/harness/:slug/insights
 *   query: ?activity_limit=N (default 20, capped at 100)
 *
 * Returns full InsightsTabProps for the harness. Public read.
 * Defensive per loaders: missing tables yield zeros / empty arrays
 * so the response is always 200-shaped.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24 P-073.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import { loadHarnessInsights } from '../../../harness-insights/load-all';
import {
  loadProjectCardFromGithub,
  loadGithubContributorCommits,
  loadRepoReadme,
  loadGithubMergedPrEvents,
} from '../../../harness-insights/github-facts';
import { getSessionUserOrDefault } from '../../../auth';

async function viewerGithubUserId(): Promise<number> {
  try {
    const user = await getSessionUserOrDefault();
    const ghId = (user as { github_user_id?: number | string | null })?.github_user_id;
    if (typeof ghId === 'number' && Number.isFinite(ghId)) return ghId;
    if (typeof ghId === 'string') {
      const parsed = Number.parseInt(ghId, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

const get = defineTool({
  method: 'GET',
  path: '/harness/:slug/insights',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();
    const url = new URL(req.url);
    const rawLimit = Number.parseInt(
      url.searchParams.get('activity_limit') ?? '20',
      10,
    );
    const activityLimit = Math.max(
      1,
      Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 20),
    );
    const viewerId = await viewerGithubUserId();
    const { sql } = getOrgPg();
    const runQuery = async <T,>(
      query: string,
      paramsArr: unknown[],
    ): Promise<T[]> => {
      return (await sql.unsafe(query, paramsArr as never)) as unknown as T[];
    };
    // Tier-A ProjectCard facts from the harness's GitHub repo (P-073a).
    // Degrades to the slug-derived fallback when there's no token / remote /
    // repo, and never throws.
    const project = await loadProjectCardFromGithub({
      workspaceId,
      harnessSlug: slug,
    });
    // Tier-A GitHub commit counts merged onto the People card (P-073c).
    const peopleCommits = await loadGithubContributorCommits({
      workspaceId,
      harnessSlug: slug,
    });
    // Tier-A repo README for the HowItWorksHere card's orientation (P-004).
    // Same degrade-to-fallback contract: undefined when no token / remote / README.
    const readme = await loadRepoReadme({ workspaceId, harnessSlug: slug });
    // Tier-A merged-PR activity events from the GitHub API (P-003), interleaved
    // with the PG ledger in the ActivityFeedCard and deduped by PR number.
    // Same degrade-to-fallback contract: undefined when no token / remote / PRs.
    const githubActivityEvents = await loadGithubMergedPrEvents({
      workspaceId,
      harnessSlug: slug,
      limit: activityLimit,
    });
    const props = await loadHarnessInsights({
      workspace_id: workspaceId,
      harness_slug: slug,
      viewer_github_user_id: viewerId,
      runQuery,
      project,
      peopleCommits,
      howItWorks: { readme },
      activityLimit,
      githubActivityEvents,
    });
    return Response.json({ insights: props });
  },
});

export default [get];
