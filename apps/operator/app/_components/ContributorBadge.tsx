'use client';

/**
 * ContributorBadge — Phase 8 P-071.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 addendum 3 §17 trust tiers — shared component used by:
 *   - §9.2 Contributors tab (per-row activity)
 *   - §9.0 Insights "People" card avatar stack
 *   - Feature + PR card author chips
 *   - §18 user profile activity feed
 *
 * Four tiers, distinct visual treatment per v5 §17 trust ledger:
 *
 *   Tier A (verifiable: GitHub-API-backed PRs merged)
 *     → ✓ pill, accent color. Highest trust.
 *
 *   Tier B (verifiable: features-shipped via completion_ref)
 *     → ✓ pill, secondary color.
 *
 *   Tier C (self-asserted: contributor_usage_events rollup)
 *     → unmarked pill, dim color. No ✓.
 *
 *   Tier D (unverifiable: own spend in USD)
 *     → ⏱ pill, viewer-only. Rendered only when `viewerOnly === true`.
 *
 * Stats are passed in pre-computed; the badge doesn't query data.
 * That keeps it usable from any surface and trivially testable.
 *
 * Tooltip on hover explains the tier so first-time viewers learn
 * the trust model.
 */

import type { CSSProperties, ReactNode } from 'react';

export type ContributorTier = 'A' | 'B' | 'C' | 'D';

export interface ContributorBadgeProps {
  tier: ContributorTier;
  /** Numeric value to display (PRs merged, features shipped, etc). */
  value: number;
  /** Short label for the number (e.g. "PRs", "features", "events"). */
  label: string;
  /**
   * When the badge represents tier-D (self-only spend), the caller
   * must pass `viewerOnly: true` to acknowledge the privacy gate.
   * Tier-D rendered without this flag is suppressed — defensive
   * against accidental cross-user spend exposure.
   */
  viewerOnly?: boolean;
}

const BADGE_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 12,
  fontSize: 12,
  fontWeight: 500,
  border: '1px solid var(--border)',
  cursor: 'help',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

interface TierStyle {
  marker: string;                 // glyph: ✓, ⏱, or ''
  background: string;
  color: string;
  tooltip: string;
}

const TIER_STYLES: Record<ContributorTier, TierStyle> = {
  A: {
    marker: '✓',
    background: 'var(--accent-soft, rgba(76, 175, 80, 0.15))',
    color: 'var(--accent, #4CAF50)',
    tooltip: 'Tier A — verifiable via GitHub API (PRs merged). Highest trust.',
  },
  B: {
    marker: '✓',
    background: 'var(--bg-2)',
    color: 'var(--fg)',
    tooltip: 'Tier B — verifiable via completion_ref (features shipped).',
  },
  C: {
    marker: '',
    background: 'var(--bg-1, transparent)',
    color: 'var(--fg-dim)',
    tooltip: 'Tier C — self-asserted activity (no remote verification).',
  },
  D: {
    marker: '⏱',
    background: 'var(--warn-bg, rgba(255, 152, 0, 0.12))',
    color: 'var(--warn, #FF9800)',
    tooltip: 'Tier D — self-reported spend (visible only to you).',
  },
};

export function ContributorBadge(props: ContributorBadgeProps): ReactNode {
  const { tier, value, label, viewerOnly = false } = props;

  // Privacy gate — tier-D requires explicit viewer-only opt-in.
  if (tier === 'D' && !viewerOnly) return null;

  const style = TIER_STYLES[tier];
  const composed: CSSProperties = {
    ...BADGE_BASE,
    background: style.background,
    color: style.color,
  };

  return (
    <span
      data-tier={tier}
      data-testid={`contributor-badge-tier-${tier.toLowerCase()}`}
      title={style.tooltip}
      style={composed}
    >
      {style.marker && <span aria-hidden="true">{style.marker}</span>}
      <span>{value}</span>
      <span style={{ color: 'var(--fg-dim)' }}>{label}</span>
    </span>
  );
}

/**
 * Convenience: render the full 3-pill row for a contributor. Order
 * matches the v5 §17 visual grouping (A → B → C). Tier D is shown
 * separately on viewer-only surfaces.
 */
export interface ContributorBadgeRowProps {
  prsMerged: number;
  featuresShipped: number;
  activityEvents: number;
}

export function ContributorBadgeRow(props: ContributorBadgeRowProps): ReactNode {
  const { prsMerged, featuresShipped, activityEvents } = props;
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <ContributorBadge tier="A" value={prsMerged} label="PRs" />
      <ContributorBadge tier="B" value={featuresShipped} label="features" />
      <ContributorBadge tier="C" value={activityEvents} label="events" />
    </span>
  );
}
