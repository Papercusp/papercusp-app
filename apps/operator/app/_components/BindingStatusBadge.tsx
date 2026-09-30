'use client';

/**
 * BindingStatusBadge — Phase 8 P-048a + P-075 UI partner.
 *
 * Plan: papercusp-dogfood-phase8-sidebar-insights-profile-2026-05-24.
 * v5 §0.2.7 two-channel binding state per contributor row.
 *
 * Three states:
 *
 *   verified   — both Channel 1 (gh /user) and Channel 2 (contributor
 *                file) check out. Activity stats can be trusted.
 *
 *   pending    — within the grace window (default 24h, max 1 week).
 *                Newly-joined contributor; binding not yet verified.
 *
 *   unverified — either channel failed or grace window expired.
 *                Stats greyed out, claim CTA disabled.
 *
 * Reads from the BindingStatus type in
 * `apps/operator/lib/identity/binding-verifier-types.ts` (P-075).
 */

import type { CSSProperties, ReactNode } from 'react';

import type { BindingStatus } from '@papercusp/operator-core/lib/identity/binding-verifier-types';
export type { BindingStatus };

export interface BindingStatusBadgeProps {
  status: BindingStatus;
  /** Optional override: when pending, how long since joining. Renders inline. */
  pendingAgeText?: string;
  /** Optional override: when unverified, the failure reason for the tooltip. */
  unverifiedReason?: string;
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
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  cursor: 'help',
};

interface StatusStyle {
  marker: string;
  label: string;
  background: string;
  color: string;
  tooltip: string;
}

const STATUS_STYLES: Record<BindingStatus, StatusStyle> = {
  verified: {
    marker: '✓',
    label: 'verified',
    background: 'var(--accent-soft, rgba(76, 175, 80, 0.15))',
    color: 'var(--accent, #4CAF50)',
    tooltip: 'Two-channel binding verified: GitHub API confirms the contributor, and their device-signed file is present.',
  },
  pending: {
    marker: '⏳',
    label: 'pending',
    background: 'var(--bg-2)',
    color: 'var(--fg-dim)',
    tooltip: 'Binding verification in progress. Activity stats will appear once verification completes (within ~24h).',
  },
  unverified: {
    marker: '⚠',
    label: 'unverified',
    background: 'var(--warn-bg, rgba(255, 152, 0, 0.12))',
    color: 'var(--warn, #FF9800)',
    tooltip: 'Two-channel binding could not be verified. Activity stats are not counted; claim actions are disabled.',
  },
};

export function BindingStatusBadge(props: BindingStatusBadgeProps): ReactNode {
  const { status, pendingAgeText, unverifiedReason } = props;
  const style = STATUS_STYLES[status];
  const composed: CSSProperties = {
    ...BADGE_BASE,
    background: style.background,
    color: style.color,
  };
  const tooltip = status === 'unverified' && unverifiedReason
    ? `${style.tooltip} (${unverifiedReason})`
    : style.tooltip;
  return (
    <span
      data-binding-status={status}
      data-testid={`binding-status-badge-${status}`}
      title={tooltip}
      style={composed}
    >
      <span aria-hidden="true">{style.marker}</span>
      <span>{style.label}</span>
      {status === 'pending' && pendingAgeText && (
        <span style={{ color: 'var(--fg-dim)' }}>· {pendingAgeText}</span>
      )}
    </span>
  );
}
