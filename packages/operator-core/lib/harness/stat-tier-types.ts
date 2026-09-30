/**
 * stat-tier-types — types for the §17 stat trust-tier framework
 * per papercusp-dogfood-v5 (D-030 in addendum 3).
 *
 * Types-only and PURE. No I/O.
 *
 * Twenty-fifth module in the dogfood-arc types-only spine.
 *
 * Per v5 §17:
 *   Every collaboration stat surfaced in shared-harness UIs carries
 *   a trust tier. Tiers reflect what mechanism makes the number
 *   trustworthy, not how recent or polished it is. They never
 *   aggregate across tiers.
 *
 *   A = GitHub-derived (✓)
 *   B = completion_ref-verified (✓)
 *   C = Hyperbee-claimed (unmarked)
 *   D = self-reported / local-only (⏱)
 *
 * Plus surface rules per §17 ("Cupboard = tier-A only" etc.) and
 * the unverified-contributors-aggregate-to-nothing invariant (§0.2.7).
 *
 * Used by every UI that surfaces a stat number:
 *   §9.0 Insights, §9.2 Contributors, §10 Cupboard, §18 user profile,
 *   feature/PR card avatars.
 */

export const STAT_TIERS = ['A', 'B', 'C', 'D'] as const;
export type StatTier = (typeof STAT_TIERS)[number];

/**
 * Badge glyph per tier per §17 table.
 *
 *   A → "✓"   (GitHub-derived; viewer can re-derive)
 *   B → "✓"   (completion_ref-verified)
 *   C → ""    (Hyperbee-claimed; unmarked)
 *   D → "⏱"   (self-reported / local-only)
 */
export const STAT_TIER_BADGE: Record<StatTier, string> = {
  A: '✓',
  B: '✓',
  C: '',
  D: '⏱',
};

/**
 * Surfaces where stats appear, per §17 surface rules table.
 */
export const STAT_SURFACES = [
  'cupboard',
  'insights',
  'contributors',
  'user_profile_public',
  'user_profile_member',
  'card_avatar',
] as const;
export type StatSurface = (typeof STAT_SURFACES)[number];

/**
 * Per-surface allow-set per §17 surface rules. Each surface lists
 * the tiers permitted on it. Stats outside the allow-set MUST NOT
 * render on that surface.
 *
 *   cupboard               → tier-A only
 *   insights               → all four
 *   contributors           → A + B + C (+ D when viewer === self)
 *   user_profile_public    → A + B (when harness is shared-public)
 *   user_profile_member    → A + B + C (when viewer is harness member)
 *   card_avatar            → A + B (only verified-by-evidence on tiny surfaces)
 */
export const SURFACE_ALLOWED_TIERS: Record<StatSurface, ReadonlySet<StatTier>> = {
  cupboard: new Set(['A']),
  insights: new Set(['A', 'B', 'C', 'D']),
  contributors: new Set(['A', 'B', 'C', 'D']),
  user_profile_public: new Set(['A', 'B']),
  user_profile_member: new Set(['A', 'B', 'C']),
  card_avatar: new Set(['A', 'B']),
};

/**
 * A single tagged stat value. The number + the tier travel together.
 */
export interface TieredStat<T = number> {
  value: T;
  tier: StatTier;
  /** Optional label for UI display ("features shipped", "PRs merged"). */
  label?: string;
}

/**
 * Predicate: is this tier permitted on this surface?
 */
export function isTierAllowedOnSurface(tier: StatTier, surface: StatSurface): boolean {
  return SURFACE_ALLOWED_TIERS[surface].has(tier);
}

/**
 * Filter a list of tiered stats to only those that can render on a
 * given surface. UI consumers call this once per render rather than
 * spreading `if` checks across markup.
 */
export function filterStatsForSurface<T>(
  stats: ReadonlyArray<TieredStat<T>>,
  surface: StatSurface,
): TieredStat<T>[] {
  return stats.filter((s) => isTierAllowedOnSurface(s.tier, surface));
}

/**
 * Group stats by tier. Useful for "render each tier in its own
 * column / row" UI patterns (e.g. Insights People card).
 */
export function groupStatsByTier<T>(
  stats: ReadonlyArray<TieredStat<T>>,
): Record<StatTier, TieredStat<T>[]> {
  const out: Record<StatTier, TieredStat<T>[]> = { A: [], B: [], C: [], D: [] };
  for (const s of stats) {
    out[s.tier].push(s);
  }
  return out;
}

/**
 * §17 invariant: aggregates within a tier are fine; sums across
 * tiers are NOT. This helper sums a list of tiered numbers but
 * refuses if any two have different tiers.
 *
 * Returns the sum + the tier, or null if the list is heterogeneous
 * (callers MUST handle null — it means "you tried to add tier-B
 * and tier-C, which §17 forbids").
 */
export function sumWithinTier(
  stats: ReadonlyArray<TieredStat<number>>,
): { value: number; tier: StatTier } | null {
  if (stats.length === 0) return null;
  const firstTier = stats[0]!.tier;
  let sum = 0;
  for (const s of stats) {
    if (s.tier !== firstTier) return null;
    sum += s.value;
  }
  return { value: sum, tier: firstTier };
}

/**
 * §17 + §0.2.7 invariant: unverified contributors contribute to
 * zero stats. Helper to zero-out a tiered stat when the contributor's
 * binding_status isn't 'verified'.
 *
 * Used by the rollup path before surfacing per-contributor stats —
 * gives a single line at the call site instead of an `if/else` ladder.
 */
export function zeroIfUnverified<T extends number>(
  stat: TieredStat<T>,
  binding_status: 'verified' | 'pending' | 'unverified',
): TieredStat<T | 0> {
  if (binding_status === 'verified') return stat;
  return { ...stat, value: 0 as T | 0 };
}

/**
 * Pure helper: render the badge string for a tier. Returns empty
 * string for tier-C (intentionally unmarked per §17 table).
 */
export function renderTierBadge(tier: StatTier): string {
  return STAT_TIER_BADGE[tier];
}

/**
 * Per §17: tiers A + B are "✓"-marked; C is unmarked; D is "⏱".
 * Predicate: is this tier a "verified by evidence" tier? Used by
 * the card-avatar surface to decide whether to render a stat at
 * all (only ✓-marked tiers).
 */
export function isVerifiedByEvidenceTier(tier: StatTier): boolean {
  return tier === 'A' || tier === 'B';
}

/**
 * The "lowest" tier whose presence still affords showing a number.
 * Per §17 + §0.2.7: tier D is viewer-only (never cross-engineer
 * verifiable); cross-engineer surfaces (every surface that isn't
 * `card_avatar` viewer-self) should NOT include D.
 *
 * Surface-specific predicate for "should I render this stat?"
 */
export function shouldRenderStatOnSurface<T>(
  stat: TieredStat<T>,
  surface: StatSurface,
  context: { viewerIsSelf?: boolean } = {},
): boolean {
  if (!isTierAllowedOnSurface(stat.tier, surface)) return false;
  // tier-D is viewer-only — even surfaces that "allow" D in the
  // table only allow it for the viewer themselves.
  if (stat.tier === 'D' && !context.viewerIsSelf) return false;
  return true;
}
