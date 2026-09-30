/**
 * insights-card-types — data shapes for the §9.0 Insights tab
 * six-card layout per papercusp-dogfood-v5 (D-029 in addendum 3).
 *
 * Types-only and PURE. No PG, no React.
 *
 * Twenty-sixth module in the dogfood-arc types-only spine.
 *
 * Per v5 §9.0 six cards, top to bottom:
 *   1. Project card
 *   2. Activity feed
 *   3. People
 *   4. Your place (viewer-contextual)
 *   5. How it works here
 *   6. Spend (self-reported, ⏱)
 *
 * Tier badges from §17 apply throughout — uses StatTier from
 * stat-tier-types.
 */

import {
  type StatTier,
  type TieredStat,
} from './stat-tier-types';
import {
  type BindingStatus,
} from '../identity/binding-verifier-types';

/**
 * The 6 card identifiers per §9.0 ordering. UI iterates this
 * tuple in the documented top-to-bottom order.
 */
export const INSIGHTS_CARDS = [
  'project',
  'activity_feed',
  'people',
  'your_place',
  'how_it_works',
  'spend',
] as const;
export type InsightsCardId = (typeof INSIGHTS_CARDS)[number];

// ─── Card 1: Project ─────────────────────────────────────────────

export interface ProjectCardData {
  kind: 'project';
  name: string;
  description: string;
  owner_provisional: boolean;
  owner_github_login: string;
  license: string | null;
  languages: string[];
  github_url: string;
  discord_channel_url: string | null;
}

// ─── Card 2: Activity feed ───────────────────────────────────────

/**
 * Activity event kinds per §9.0 card 2.
 *
 *   feature_shipped   → tier B (completion_ref-verified)
 *   pr_merged         → tier A (GitHub-derived)
 *   contributor_joined → tier C with verified-binding sub-badge
 *   decision_added    → tier C
 *   escalation_opened → tier C
 */
export const ACTIVITY_EVENT_KINDS = [
  'feature_shipped',
  'pr_merged',
  'contributor_joined',
  'decision_added',
  'escalation_opened',
] as const;
export type ActivityEventKind = (typeof ACTIVITY_EVENT_KINDS)[number];

/**
 * Per-kind tier mapping per §9.0. Drives badge rendering directly.
 */
export const ACTIVITY_EVENT_TIER: Record<ActivityEventKind, StatTier> = {
  feature_shipped: 'B',
  pr_merged: 'A',
  contributor_joined: 'C',
  decision_added: 'C',
  escalation_opened: 'C',
};

export interface ActivityEvent {
  kind: ActivityEventKind;
  /** Epoch ms when the event happened. Sort key (newest-first). */
  ts: number;
  /** Display label (e.g. "Alice shipped F-042"). */
  label: string;
  /** Click target URL within the operator UI. */
  detail_url: string;
  /** For contributor_joined events: the bound github_user_id whose
   * binding state determines the verified sub-badge. */
  github_user_id?: number;
  binding_status?: BindingStatus;
}

/**
 * Default count cap per §9.0 ("last ~20 events").
 */
export const ACTIVITY_FEED_DEFAULT_LIMIT = 20;

export interface ActivityFeedCardData {
  kind: 'activity_feed';
  events: ActivityEvent[];
}

/**
 * Sort + cap helper. Newest-first per §9.0.
 */
export function buildActivityFeedCardData(
  events: ReadonlyArray<ActivityEvent>,
  limit: number = ACTIVITY_FEED_DEFAULT_LIMIT,
): ActivityFeedCardData {
  const sorted = events.slice().sort((a, b) => b.ts - a.ts);
  return { kind: 'activity_feed', events: sorted.slice(0, Math.max(0, limit)) };
}

// ─── Card 3: People ──────────────────────────────────────────────

export interface PersonRow {
  github_user_id: number;
  github_login: string;
  avatar_url: string | null;
  binding_status: BindingStatus;
}

export interface PeopleCardData {
  kind: 'people';
  people: PersonRow[];
}

/**
 * Predicate per §0.2.7: only verified contributors count for any
 * tier-A/B/C aggregate. Helper to split the people-card avatar
 * stack into "counts toward stats" vs "shown but doesn't count."
 */
export function partitionPeopleByVerification(
  people: ReadonlyArray<PersonRow>,
): { verified: PersonRow[]; unverified: PersonRow[] } {
  const verified: PersonRow[] = [];
  const unverified: PersonRow[] = [];
  for (const p of people) {
    if (p.binding_status === 'verified') verified.push(p);
    else unverified.push(p);
  }
  return { verified, unverified };
}

// ─── Card 4: Your place ──────────────────────────────────────────

export interface YourPlaceCardData {
  kind: 'your_place';
  queue_in_progress: number; // currently working
  queue_pending: number; // in queue waiting
  /** "you hold pr-review for this harness" / "your contributions await review" */
  role_state: 'reviewer' | 'contributor' | 'observer';
  /** "trusted by 2 of 3 reviewers" — numerator + denominator. */
  trusted_by: { count: number; total: number };
  /** Tier-D spend stat, viewer-only. */
  spend_this_week: TieredStat<number>;
}

// ─── Card 5: How it works here ───────────────────────────────────

export interface HowItWorksCardData {
  kind: 'how_it_works';
  auto_merge_enabled: boolean;
  auto_review_enabled_for_viewer: boolean;
  branch_pattern: string;
  active_reviewer_count: number;
  peer_mirror_state: 'on' | 'off' | 'optional';
}

// ─── Card 6: Spend ───────────────────────────────────────────────

export interface SpendCardData {
  kind: 'spend';
  /** Tier-D — viewer-only per §17. */
  viewer_spend_this_week: TieredStat<number>;
  /** Tier-D — "your share of estimated harness spend this week." */
  viewer_share_of_harness: TieredStat<number>;
  /** Display the proxy-witness deferral banner. Always true until
   * proxy-witness pattern ships. */
  show_proxy_witness_banner: boolean;
}

// ─── Aggregate ───────────────────────────────────────────────────

/**
 * The full payload for one Insights tab render. UI iterates
 * INSIGHTS_CARDS in order to render each.
 */
export type InsightsCardData =
  | ProjectCardData
  | ActivityFeedCardData
  | PeopleCardData
  | YourPlaceCardData
  | HowItWorksCardData
  | SpendCardData;

export interface InsightsTabData {
  project: ProjectCardData;
  activity_feed: ActivityFeedCardData;
  people: PeopleCardData;
  your_place: YourPlaceCardData;
  how_it_works: HowItWorksCardData;
  spend: SpendCardData;
}

/**
 * Predicate per §9.0 reduced surface: private harnesses show
 * fewer cards. "private" → only project + how-it-works + spend
 * (no contributor/proxy material).
 */
export function visibleCardsForHarnessState(
  state: 'private' | 'shared-private' | 'shared-public',
): InsightsCardId[] {
  if (state === 'private') {
    return ['project', 'how_it_works', 'spend'];
  }
  return [...INSIGHTS_CARDS];
}

/**
 * Predicate: is this card "viewer-contextual" (re-renders when
 * viewer identity changes)? Used by client-side caching to avoid
 * showing card 4 + 6 to a different viewer than they were
 * computed for.
 */
export function isViewerContextualCard(id: InsightsCardId): boolean {
  return id === 'your_place' || id === 'spend';
}

/**
 * Predicate per §9.0 ordering constraint: are P-070 (usage ledger)
 * + P-075 (binding verifier) ready? If not, Insights' People +
 * Activity surfaces MUST NOT render (per "P-073 is blocked-by
 * P-075" in the §9.0 ordering constraint).
 *
 * Pure gate function — UI calls this before assembling the cards.
 */
export function canRenderInsightsHonestly(deps: {
  usage_ledger_ready: boolean;
  binding_verifier_ready: boolean;
}): boolean {
  return deps.usage_ledger_ready && deps.binding_verifier_ready;
}
