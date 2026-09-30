/**
 * loadHarnessInsights — single composer for the Insights tab.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24
 *       (P-073 assembly).
 *
 * Calls every per-card loader in parallel and assembles InsightsTabProps.
 * The two cards whose data is not PG-rooted (Project + HowItWorksHere)
 * accept caller-supplied overrides; without them, sensible defaults
 * keyed off the harness slug surface.
 *
 * Pure logic — same injectable runQuery as the per-card loaders.
 */

import type { InsightsTabProps } from './card-types';
import type {
  ProjectCardProps,
} from './card-types';
import type {
  HowItWorksHereCardProps,
} from './card-types';
import type { PeopleCardPerson } from './card-types';
import type { ActivityFeedEvent } from './card-types';
import { loadHarnessActivity } from '../harness-activity/load';
import { loadHarnessPeople } from './load-people';
import { loadYourPlace } from './load-your-place';
import { loadHarnessSpend } from './load-spend';

export interface LoadHarnessInsightsOpts {
  workspace_id: string;
  harness_slug: string;
  viewer_github_user_id: number;
  runQuery: <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;
  /** Static-but-needed fields the loaders can't compute from PG alone. */
  project?: Partial<ProjectCardProps>;
  howItWorks?: Partial<HowItWorksHereCardProps>;
  /** Limits */
  activityLimit?: number;
  peopleLimit?: number;
  /** Tier-A per-login GitHub commit counts, merged into People rows. */
  peopleCommits?: Record<string, number>;
  /**
   * Tier-A GitHub-sourced activity events (merged PRs) to interleave with
   * the PG-ledger activity feed. Deduped by PR number against the PG
   * `pr_merged` events. Omitted (no token / no remote) → PG-only feed.
   */
  githubActivityEvents?: ActivityFeedEvent[];
}

/** Merge tier-A GitHub commit counts onto People rows (matched by login). */
function mergePeopleCommits(
  people: PeopleCardPerson[],
  commits: Record<string, number> | undefined,
): PeopleCardPerson[] {
  if (!commits) return people;
  return people.map((p) => {
    const c = commits[p.login.toLowerCase()];
    return typeof c === 'number' ? { ...p, commitCount: c } : p;
  });
}

function fallbackProject(
  harness_slug: string,
  override: Partial<ProjectCardProps> = {},
): ProjectCardProps {
  return {
    name: override.name ?? harness_slug,
    description: override.description ?? '',
    ownerDisplayName: override.ownerDisplayName ?? 'unknown',
    claimStatus: override.claimStatus ?? 'unclaimed',
    claimantLogin: override.claimantLogin ?? null,
    license: override.license ?? null,
    languages: override.languages ?? [],
    githubUrl:
      override.githubUrl ?? `https://github.com/${harness_slug}`,
    discordUrl: override.discordUrl ?? null,
    stars: override.stars ?? null,
    forks: override.forks ?? null,
    openIssues: override.openIssues ?? null,
    lastActivityIso: override.lastActivityIso ?? null,
    topics: override.topics ?? [],
    latestRelease: override.latestRelease ?? null,
  };
}

function fallbackHowItWorks(
  harness_slug: string,
  override: Partial<HowItWorksHereCardProps> = {},
): HowItWorksHereCardProps {
  return {
    harnessName: override.harnessName ?? harness_slug,
    config: override.config ?? {
      has_orchestrator: true,
      pr_reviewer_role_enabled: false,
      auto_review: false,
      auto_merge: false,
      merge_method: 'squash',
      branch_policy: 'feature-branch',
    },
    customWelcome: override.customWelcome ?? null,
    readme: override.readme ?? null,
  };
}

export async function loadHarnessInsights(
  opts: LoadHarnessInsightsOpts,
): Promise<InsightsTabProps> {
  const {
    workspace_id,
    harness_slug,
    viewer_github_user_id,
    runQuery,
  } = opts;

  const [activityEvents, peopleRows, yourPlaceProps, spendProps] =
    await Promise.all([
      loadHarnessActivity({
        workspace_id,
        harness_slug,
        limit: opts.activityLimit ?? 20,
        runQuery,
        githubEvents: opts.githubActivityEvents,
      }),
      loadHarnessPeople({
        workspace_id,
        harness_slug,
        limit: opts.peopleLimit ?? 50,
        runQuery,
      }),
      loadYourPlace({
        workspace_id,
        harness_slug,
        viewer_github_user_id,
        runQuery,
      }),
      loadHarnessSpend({
        workspace_id,
        harness_slug,
        runQuery,
      }),
    ]);

  return {
    project: fallbackProject(harness_slug, opts.project),
    activity: { events: activityEvents },
    people: { people: mergePeopleCommits(peopleRows, opts.peopleCommits) },
    yourPlace: yourPlaceProps,
    howItWorks: fallbackHowItWorks(harness_slug, opts.howItWorks),
    spend: spendProps,
  };
}
