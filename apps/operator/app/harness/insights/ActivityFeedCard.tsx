'use client';

/**
 * ActivityFeedCard — Phase 8 P-073b.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §9.0 + §17 trust tiers.
 *
 * Last ~20 events with tier badges. Event kinds + their tier:
 *   - feature_shipped (B ✓)
 *   - pr_merged       (A ✓)
 *   - contributor_joined (C)
 *   - decision_added  (C)
 *   - escalation_opened (C)
 *
 * Each row: icon · short prose · @who · relative time · tier pill.
 * Click → detail URL chosen by caller.
 *
 * Pure UI. Consumer supplies pre-computed event rows.
 */

import type { CSSProperties, ReactNode } from 'react';
import type {
  ActivityKind,
  ActivityFeedEvent,
  ActivityFeedCardProps,
} from '@papercusp/operator-core/lib/harness-insights/card-types';

const TIER_BY_KIND: Record<ActivityKind, 'A' | 'B' | 'C'> = {
  pr_merged: 'A',
  feature_shipped: 'B',
  contributor_joined: 'C',
  decision_added: 'C',
  escalation_opened: 'C',
};

const TIER_COLOR: Record<'A' | 'B' | 'C', string> = {
  A: 'var(--good)',
  B: 'var(--accent)',
  C: 'var(--fg-dim)',
};

const ICON_BY_KIND: Record<ActivityKind, string> = {
  feature_shipped: '✓',
  pr_merged: '⤴',
  contributor_joined: '+',
  decision_added: '⚖',
  escalation_opened: '!',
};

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

const LIST: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
};

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 0',
  borderBottom: '1px solid var(--border)',
  fontSize: 13,
  textDecoration: 'none',
  color: 'inherit',
};

const ICON: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 600,
  fontSize: 14,
  flexShrink: 0,
};

const PROSE: CSSProperties = {
  flex: 1,
  color: 'var(--fg)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const WHO: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-dim)',
};

const TIME: CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-dim)',
  whiteSpace: 'nowrap',
};

const TIER_PILL: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  padding: '1px 6px',
  borderRadius: 6,
  border: '1px solid currentColor',
  textTransform: 'uppercase',
};

const EMPTY: CSSProperties = {
  fontSize: 13,
  color: 'var(--fg-dim)',
};

export type { ActivityKind, ActivityFeedEvent, ActivityFeedCardProps };

export function ActivityFeedCard(
  props: ActivityFeedCardProps,
): ReactNode {
  const { events, maxRows = 20 } = props;
  const visible = events.slice(0, maxRows);

  return (
    <div style={CARD} data-testid="insights-activity-feed-card">
      <div style={TITLE}>Activity</div>

      {visible.length === 0 ? (
        <div style={EMPTY} data-testid="activity-feed-empty">
          No activity yet.
        </div>
      ) : (
        <div style={LIST}>
          {visible.map((e) => {
            const tier = TIER_BY_KIND[e.kind];
            const color = TIER_COLOR[tier];
            const inner = (
              <>
                <div
                  style={{ ...ICON, background: `color-mix(in oklab, ${color}, transparent 86%)`, color }}
                  data-testid={`activity-row-icon-${e.id}`}
                >
                  {ICON_BY_KIND[e.kind]}
                </div>
                <div style={PROSE}>{e.text}</div>
                <div style={WHO}>@{e.actorLogin}</div>
                <div style={TIME}>{e.whenLabel}</div>
                <div
                  style={{ ...TIER_PILL, color }}
                  data-testid={`activity-row-tier-${e.id}`}
                >
                  {tier}
                </div>
              </>
            );
            return e.href ? (
              <a
                key={e.id}
                href={e.href}
                style={ROW}
                data-testid={`activity-row-${e.id}`}
              >
                {inner}
              </a>
            ) : (
              <div
                key={e.id}
                style={ROW}
                data-testid={`activity-row-${e.id}`}
              >
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
