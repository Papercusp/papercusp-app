/**
 * Insights-tab card data contracts.
 *
 * Pure types, NO React/UI. These are the data shapes the per-card loaders
 * (this directory) PRODUCE and the §9.0 Insights UI components
 * (app/harness/insights/*) CONSUME. They previously lived inline in the
 * `'use client'` component files, which forced the backend loaders to
 * import from `app/**` (a backend→UI back-edge). Relocated here in core so
 * the dependency points the right way (UI → core) during the operator-core
 * carve (plan operator-core-headless-serve-2026-06-04, Stage A).
 *
 * NOTE: these are the component contracts, distinct from the dogfood
 * data-spine shapes in `../harness/insights-card-types.ts` (which evolved
 * separately). Don't conflate the two.
 */
import type { ClaimStatus } from '../harness/claim-status-types';

// ─── Card 1: Project ─────────────────────────────────────────────

export interface ProjectCardLanguage {
  name: string;
  /** Hex color matching the language. */
  color: string;
  /** Percentage 0-100. Used to size visual weight; not rendered here. */
  percent: number;
}

export interface ProjectCardProps {
  /** Harness slug or display name. */
  name: string;
  /** One-line description, usually from harness config. */
  description: string;
  /** Owner's GitHub login (or display name). */
  ownerDisplayName: string;
  /** Used to render ClaimStatusBadge in the title row. */
  claimStatus: ClaimStatus;
  /** Optional — for status='claimed', the lead claimant login. */
  claimantLogin?: string | null;
  /** Repo license short name (e.g. 'MIT', 'Apache-2.0'). */
  license?: string | null;
  /** Top 3 languages, ordered by percent desc. */
  languages?: ProjectCardLanguage[];
  /** GitHub repo URL. */
  githubUrl: string;
  /** Optional — Discord server URL if §11 is set. */
  discordUrl?: string | null;
  /** GitHub stars (tier-A — verifiable via the GitHub API). */
  stars?: number | null;
  /** GitHub fork count. */
  forks?: number | null;
  /** Open issues on GitHub. */
  openIssues?: number | null;
  /** ISO timestamp of the repo's last push (GitHub `pushed_at`). */
  lastActivityIso?: string | null;
  /** Repo topics (GitHub `topics`), rendered as pills. */
  topics?: string[];
  /** Latest GitHub release (tag + publish date), if any. */
  latestRelease?: {
    tag: string;
    publishedAtIso?: string | null;
    url?: string | null;
  } | null;
}

// ─── Card 2: Activity feed ───────────────────────────────────────

export type ActivityKind =
  | 'feature_shipped'
  | 'pr_merged'
  | 'contributor_joined'
  | 'decision_added'
  | 'escalation_opened';

export interface ActivityFeedEvent {
  id: string;
  kind: ActivityKind;
  /** Short prose, e.g. `'shipped F-DOGFOOD-001'`. */
  text: string;
  /** GitHub login of the actor. */
  actorLogin: string;
  /** Display string, e.g. `'3m ago'`. */
  whenLabel: string;
  /** Click target. Optional — if absent, row is non-clickable. */
  href?: string | null;
  /**
   * Source timestamp (epoch ms). Used by the loader to sort + interleave
   * events across sources (PG + GitHub) recency-correctly, and to dedupe.
   * Not rendered (the card shows `whenLabel`). Optional so older callers
   * that only set `whenLabel` keep working.
   */
  tsEpoch?: number;
  /**
   * Stable dedupe key for cross-source merges. Two events with the same
   * key are the same real-world event surfaced by different sources (e.g.
   * a merged PR seen both via the local `auto_review_audit` ledger and the
   * GitHub API) — the merge keeps one. Optional; events without a key are
   * never deduped against each other.
   */
  dedupKey?: string | null;
}

export interface ActivityFeedCardProps {
  events: ActivityFeedEvent[];
  /** Truncate to N. Default 20. */
  maxRows?: number;
}

// ─── Card 3: People ──────────────────────────────────────────────

export interface PeopleCardPerson {
  github_user_id: number;
  login: string;
  display_name?: string | null;
  avatar_url?: string | null;
  /** Verified binding status — drives the corner badge. */
  binding_status: 'verified' | 'pending' | 'unverified';
  /** Tier-A GitHub commit count (verifiable via the GitHub API). */
  commitCount?: number | null;
}

export interface PeopleCardProps {
  /** All visible contributors. */
  people: PeopleCardPerson[];
  /** Truncate to N avatars; rest become "+N more". Default 12. */
  maxAvatars?: number;
  /** Profile URL builder. Default = `/users/github/${id}`. */
  buildProfileHref?: (person: PeopleCardPerson) => string;
}

// ─── Card 4: Your place ──────────────────────────────────────────

export interface YourPlaceQueueStats {
  queued: number;
  working: number;
  shipped_this_week: number;
}

export interface YourPlaceRoleState {
  pr_reviewer_enabled: boolean;
  is_provisional_owner: boolean;
  is_claimant: boolean;
}

export interface YourPlaceTrustState {
  trusted_authors_count: number;
  trusted_by_count: number;
}

export interface YourPlaceCardProps {
  queue: YourPlaceQueueStats;
  role: YourPlaceRoleState;
  trust: YourPlaceTrustState;
}

// ─── Card 5: How it works here ───────────────────────────────────

export type BranchPolicy =
  | 'feature-branch'
  | 'main-fast-forward'
  | 'release-branch';

export interface HowItWorksHereConfig {
  has_orchestrator: boolean;
  pr_reviewer_role_enabled: boolean;
  auto_review: boolean;
  auto_merge: boolean;
  merge_method: 'squash' | 'merge' | 'rebase';
  branch_policy: BranchPolicy;
}

export interface HowItWorksHereCardProps {
  harnessName: string;
  config: HowItWorksHereConfig;
  /** Optional override of the templated intro paragraph. */
  customWelcome?: string | null;
  /**
   * The repo's README markdown (tier-A — fetched from GitHub), rendered
   * read-only below the workflow steps for new-joiner orientation (P-004).
   * Omitted/null → the README section doesn't render.
   */
  readme?: string | null;
}

// ─── Card 6: Spend ───────────────────────────────────────────────

/**
 * Real per-harness spend from `agent_usage_samples` (cross-backend-cost-capture
 * P-006). No per-viewer line: agent runs are orchestrator-spawned, not
 * attributable to a person (D-003 #2).
 */
export interface SpendCardProps {
  /** Total spend this week on the harness, USD (provider-billed + estimated). */
  harnessTotalUsdThisWeek: number;
  /** Portion of the total priced from tokens × list price (codex etc.), USD. */
  estimatedUsdThisWeek: number;
  /** Token throughput this week (uncached input + output). */
  tokensThisWeek: number;
  /** Number of usage samples (≈ agent runs/calls) contributing this week. */
  runsThisWeek: number;
}

// ─── Aggregate: the full Insights tab contract ───────────────────

export interface InsightsTabProps {
  project: ProjectCardProps;
  activity: ActivityFeedCardProps;
  people: PeopleCardProps;
  yourPlace: YourPlaceCardProps;
  howItWorks: HowItWorksHereCardProps;
  spend: SpendCardProps;
}

// ─── Tokens dashboard (B-TOK-UI / token-tracking-plan-and-briefs-2026-06-20) ──
//
// The Insights → Tokens subtab data, read CACHE-INCLUSIVELY from
// `agent_usage_samples` (the same 4-token sum load-spend.ts fixed in B-TOK-2:
// input + output + cache_read + cache_creation — the prior input+output-only sum
// under-counted ~5×). Distinct from SpendCardProps (a single headline total): this
// breaks spend DOWN by model, role, and time so the owner can see WHERE the burn is
// (the audit found opus = 90% of spend, cache-read = 82% of all tokens).

/** One grouped row of the Tokens dashboard (a model, a role, …). */
export interface TokenGroupRow {
  /** Group label — a model id/class, or a role, or 'unattributed'. */
  key: string;
  /** Cache-inclusive token total (input + output + cache_read + cache_creation). */
  tokens: number;
  /** Spend in USD (provider-billed + estimated) attributed to this group. */
  costUsd: number;
  /** Number of usage samples (≈ runs/calls) in this group. */
  runs: number;
}

/** One time bucket (daily) of the Tokens dashboard trend. */
export interface TokenTimeBucket {
  /** Epoch ms of the bucket start (UTC day boundary). */
  startMs: number;
  /** Short display label, e.g. 'Jun 14'. */
  label: string;
  tokens: number;
  costUsd: number;
}

/** Cache-inclusive token + cost rollup for one harness over a window. */
export interface TokensDashboardSnapshot {
  /** The window these numbers cover, ms (default 7d). */
  windowMs: number;
  /** Headline totals — the cache breakdown is surfaced so the ~5× is visible. */
  totals: {
    tokens: number;
    costUsd: number;
    /** Portion priced from tokens × list price (codex etc.). */
    estimatedUsd: number;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  /** Spend by model (raw model id, falling back to model_class), desc by tokens. */
  byModel: TokenGroupRow[];
  /** Spend by agent role, desc by tokens. */
  byRole: TokenGroupRow[];
  /** Spend by provider account id, desc by tokens. Empty when samples are unattributed. */
  byAccount: TokenGroupRow[];
  /** Daily token/cost trend across the window, ascending by time. */
  byDay: TokenTimeBucket[];
  /**
   * True when `agent_usage_samples.account_id` is present and queried. The
   * breakdown may still be empty if the selected window only has pre-migration or
   * unpinned samples.
   */
  accountAttributionAvailable: boolean;
}
