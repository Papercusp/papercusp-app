'use client';

/**
 * YourPlaceCard — Phase 8 P-073d.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.0 Insights tab — viewer-specific card.
 *
 * Renders four viewer-scoped summaries:
 *   1. Queue summary — features in viewer's queue / working / shipped
 *   2. Role state    — PR-reviewer role on/off, claimant?, provisional?
 *   3. Trust state   — N trusted authors / trusted-by N others
 *   4. Spend ⏱       — viewer's tool-invocation $/sec for this week.
 *                       Tier-D (viewer-only); never seen by others.
 *
 * Pure UI. Consumer computes and passes.
 */

import type { CSSProperties, ReactNode } from 'react';
import type {
  YourPlaceQueueStats,
  YourPlaceRoleState,
  YourPlaceTrustState,
  YourPlaceCardProps,
} from '@papercusp/operator-core/lib/harness-insights/card-types';

const CARD: CSSProperties = {
  border: '1px solid var(--border)',
  background: 'var(--bg-1)',
  borderRadius: 8,
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  fontSize: 14,
};

const TITLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--fg)',
};

const SECTION: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  paddingTop: 8,
  borderTop: '1px solid var(--border)',
};

const SECTION_TITLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  color: 'var(--fg-dim)',
};

const STATS_ROW: CSSProperties = {
  display: 'flex',
  gap: 14,
  fontSize: 13,
  color: 'var(--fg)',
};

const STAT_VAL: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--fg)',
};

const STAT_LABEL: CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-dim)',
};

const BADGE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 500,
  background: 'var(--bg-2)',
  color: 'var(--fg-dim)',
  marginRight: 4,
};

const BADGE_ACTIVE: CSSProperties = {
  ...BADGE,
  background: 'color-mix(in oklab, var(--good), transparent 84%)',
  color: 'var(--good)',
};

export type {
  YourPlaceQueueStats,
  YourPlaceRoleState,
  YourPlaceTrustState,
  YourPlaceCardProps,
};

export function YourPlaceCard(props: YourPlaceCardProps): ReactNode {
  const { queue, role, trust } = props;

  const roleBadges: Array<{
    key: string;
    label: string;
    active: boolean;
  }> = [
    {
      key: 'reviewer',
      label: 'PR reviewer',
      active: role.pr_reviewer_enabled,
    },
    {
      key: 'provisional',
      label: 'Provisional owner',
      active: role.is_provisional_owner,
    },
    {
      key: 'claimant',
      label: 'Claimant',
      active: role.is_claimant,
    },
  ];

  return (
    <div style={CARD} data-testid="insights-your-place-card">
      <div style={TITLE}>Your place</div>

      <div style={SECTION}>
        <div style={SECTION_TITLE}>Queue</div>
        <div style={STATS_ROW} data-testid="your-place-queue">
          <div>
            <div style={STAT_VAL}>{queue.queued}</div>
            <div style={STAT_LABEL}>Queued</div>
          </div>
          <div>
            <div style={STAT_VAL}>{queue.working}</div>
            <div style={STAT_LABEL}>Working</div>
          </div>
          <div>
            <div style={STAT_VAL}>{queue.shipped_this_week}</div>
            <div style={STAT_LABEL}>Shipped this week</div>
          </div>
        </div>
      </div>

      <div style={SECTION}>
        <div style={SECTION_TITLE}>Role</div>
        <div data-testid="your-place-role">
          {roleBadges.map((b) => (
            <span
              key={b.key}
              style={b.active ? BADGE_ACTIVE : BADGE}
              data-testid={`role-${b.key}-${b.active ? 'on' : 'off'}`}
            >
              {b.active ? '✓' : '·'} {b.label}
            </span>
          ))}
        </div>
      </div>

      <div style={SECTION}>
        <div style={SECTION_TITLE}>Trust</div>
        <div style={STATS_ROW} data-testid="your-place-trust">
          <div>
            <div style={STAT_VAL}>{trust.trusted_authors_count}</div>
            <div style={STAT_LABEL}>You trust</div>
          </div>
          <div>
            <div style={STAT_VAL}>{trust.trusted_by_count}</div>
            <div style={STAT_LABEL}>Trust you</div>
          </div>
        </div>
      </div>
      {/* Per-viewer spend removed (cross-backend-cost-capture D-003 #2):
          agent runs are orchestrator-spawned with no per-person attribution.
          Harness-total spend lives on the SpendCard. */}
    </div>
  );
}
