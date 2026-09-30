'use client';

/**
 * ClaimAttemptStatsPill — Phase 6 diagnostic.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24.
 *
 * Compact 3-segment pill: ✓ won / ✗ lost / ! error. Designed for the
 * admin substrate panel + the Insights debug section. Pure UI;
 * consumer fetches the stats via /api/harness/:slug/claim-attempts?stats=1.
 *
 * Renders nothing when total === 0 (claim_audit hasn't been written to
 * yet for this harness).
 */

import type { CSSProperties, ReactNode } from 'react';

export interface ClaimAttemptStatsPillProps {
  total: number;
  won: number;
  lost: number;
  error: number;
  /** Compact mode hides counts of 0. */
  compact?: boolean;
}

const PILL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 500,
  border: '1px solid var(--border)',
  background: 'var(--bg-2)',
  color: 'var(--fg)',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

const SEG: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
};

const SEP: CSSProperties = {
  color: 'var(--fg-dim)',
  margin: '0 2px',
};

const WON: CSSProperties = {
  ...SEG,
  color: 'var(--good)',
};

const LOST: CSSProperties = {
  ...SEG,
  color: 'var(--fg-dim)',
};

const ERROR: CSSProperties = {
  ...SEG,
  color: 'var(--warn)',
};

export function ClaimAttemptStatsPill(
  props: ClaimAttemptStatsPillProps,
): ReactNode {
  const { total, won, lost, error, compact = false } = props;
  if (total === 0) return null;

  const segments: ReactNode[] = [];
  if (won > 0 || !compact) {
    segments.push(
      <span key="won" style={WON} data-testid="claim-stats-won">
        ✓ {won}
      </span>,
    );
  }
  if (lost > 0 || !compact) {
    if (segments.length > 0)
      segments.push(
        <span key="sep1" style={SEP}>
          ·
        </span>,
      );
    segments.push(
      <span key="lost" style={LOST} data-testid="claim-stats-lost">
        ✗ {lost}
      </span>,
    );
  }
  if (error > 0 || !compact) {
    if (segments.length > 0)
      segments.push(
        <span key="sep2" style={SEP}>
          ·
        </span>,
      );
    segments.push(
      <span key="error" style={ERROR} data-testid="claim-stats-error">
        ! {error}
      </span>,
    );
  }

  return (
    <span
      style={PILL}
      data-testid="claim-attempt-stats-pill"
      title={`Claim attempts: ${won} won · ${lost} lost · ${error} error (${total} total)`}
    >
      {segments}
    </span>
  );
}
